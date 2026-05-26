// vc.js — Vendor Consumer
//
// Consumes ride_requests from RabbitMQ and pushes new bookings to the
// vendor web console (vendor.html) in real time via Socket.io.
//
// The vendor acts on rides through the web console at /html/vendor.html —
// Accept / Reject / Open Market buttons call POST /api/vendor/respond/:id
// which updates the DB and pushes status_update events back to the rider.
//
// FAANG patterns:
//   Dead Letter Queue (DLQ) — after MAX_RETRIES socket/processing failures,
//   the message is routed to ride_requests_dlq with failure metadata instead
//   of looping forever on a broken channel.
//   Structured logging — every event is a typed JSON object for aggregators.

require('dotenv').config();

const amqp         = require('amqplib');
const socketModule = require('./socket');
const logger       = require('./logger');

const MAX_RETRIES = 3;
const MAIN_QUEUE  = 'ride_requests';
const DLQ         = 'ride_requests_dlq';

// ── RabbitMQ consumer ─────────────────────────────────────────────────────────
async function receiveMessages() {
  try {
    const conn    = await amqp.connect(process.env.RABBITMQ_URL || 'amqp://localhost');
    const channel = await conn.createChannel();

    await channel.assertQueue(MAIN_QUEUE, { durable: true });
    await channel.assertQueue(DLQ,        { durable: true });

    channel.prefetch(1);
    logger.info({ event: 'vc_ready', queue: MAIN_QUEUE });

    channel.consume(MAIN_QUEUE, async (msg) => {
      if (!msg) return;

      const booking    = JSON.parse(msg.content.toString());
      const retryCount = parseInt(msg.properties.headers?.['x-retry-count'] || '0', 10);

      logger.info({ event: 'vc_received', bookingId: booking.id, attempt: retryCount + 1 });

      try {
        // Push to every connected vendor console session in real time
        socketModule.getIO().to('vendor_room').emit('new_ride', booking);
        logger.info({ event: 'vc_pushed_to_vendor', bookingId: booking.id });

        channel.ack(msg);

      } catch (err) {
        logger.error({
          event:     'vc_push_failed',
          bookingId: booking.id,
          attempt:   retryCount + 1,
          message:   err.message
        });

        if (retryCount >= MAX_RETRIES) {
          // ── Dead Letter Queue ─────────────────────────────────────────────
          // Message failed MAX_RETRIES times (e.g. socket not initialised at
          // startup race, or vendor_room is empty and the emit threw).
          // ACK original + route to DLQ with failure metadata for ops replay.
          channel.sendToQueue(DLQ, msg.content, {
            persistent: true,
            headers: {
              ...msg.properties.headers,
              'x-failed-reason':  err.message,
              'x-original-queue': MAIN_QUEUE,
              'x-failed-at':      new Date().toISOString(),
              'x-retry-count':    retryCount
            }
          });
          channel.ack(msg);
          logger.error({ event: 'vc_dlq_routed', bookingId: booking.id, retries: retryCount });

        } else {
          // ── Re-publish with incremented retry counter ─────────────────────
          // Re-publish rather than nack(requeue:true) so the retry count
          // header survives and the channel head-of-line is not blocked.
          channel.sendToQueue(MAIN_QUEUE, msg.content, {
            persistent: true,
            headers: { 'x-retry-count': retryCount + 1 }
          });
          channel.ack(msg);
          logger.warn({
            event:       'vc_retry_scheduled',
            bookingId:   booking.id,
            nextAttempt: retryCount + 2
          });
        }
      }
    }, { noAck: false });

  } catch (err) {
    logger.error({ event: 'vc_rabbitmq_error', message: err.message });
    setTimeout(receiveMessages, 5000);   // reconnect after 5 s
  }
}

receiveMessages();
