// vc.js — Vendor Consumer
//
// Consumes ride_requests from RabbitMQ, notifies vendor via Telegram inline buttons,
// and pushes real-time status updates via Socket.io when the vendor responds.
//
// FAANG patterns:
//   Dead Letter Queue (DLQ) — after MAX_RETRIES failures (e.g. Telegram down),
//   the message is routed to ride_requests_dlq with failure metadata instead of
//   looping forever.  Ops can inspect / replay the DLQ without restarting the app.

require('dotenv').config();

const amqp         = require('amqplib');
const TelegramBot  = require('node-telegram-bot-api');
const pool         = require('./db');              // shared pool — no duplicate connection
const socketModule = require('./socket');
const { statusCache, bookingCache } = require('./cache');
const logger       = require('./logger');

const MAX_RETRIES = 3;
const MAIN_QUEUE  = 'ride_requests';
const DLQ         = 'ride_requests_dlq';

// ── Environment ───────────────────────────────────────────────────────────────
const {
  RABBITMQ_URL,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID
} = process.env;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  logger.error({ event: 'vc_missing_env', vars: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'] });
  process.exit(1);
}

// ── Telegram bot ──────────────────────────────────────────────────────────────
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// ── Telegram notification ─────────────────────────────────────────────────────
async function sendToTelegram(booking) {
  const message = `
🚖 *New Ride Booking* 🚖

*Guest:* ${booking.guest_name}
*Phone:* ${booking.phone}
*Pickup:* ${booking.pickup}
*Dropoff:* ${booking.dropoff}
*Vehicle:* ${booking.vehicle_type}
*Booking ID:* \`${booking.id}\`
`;

  return bot.sendMessage(TELEGRAM_CHAT_ID, message, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Accept',      callback_data: `accept_${booking.id}` },
        { text: '❌ Reject',      callback_data: `reject_${booking.id}` },
        { text: '📤 Open Market', callback_data: `open_${booking.id}`   }
      ]]
    }
  });
}

// ── Telegram button handler ───────────────────────────────────────────────────
bot.on('callback_query', async (query) => {
  const [action, rideId] = query.data.split('_');

  const newStatus =
    action === 'accept' ? 'accepted'    :
    action === 'reject' ? 'rejected'    :
    action === 'open'   ? 'open_market' : null;

  if (!newStatus) return;

  try {
    await pool.query('UPDATE rides SET status = ? WHERE id = ?', [newStatus, rideId]);

    statusCache.del(`status_${rideId}`);
    bookingCache.del(`booking_${rideId}`);

    try {
      const io = socketModule.getIO();
      io.to(`booking_${rideId}`).emit('status_update', { bookingId: rideId, status: newStatus });
      io.to('vendor_room').emit('ride_actioned', { id: rideId, status: newStatus });
      logger.info({ event: 'telegram_actioned', rideId, status: newStatus });
    } catch (socketErr) {
      logger.warn({ event: 'telegram_socket_fail', message: socketErr.message });
    }

    bot.sendMessage(
      TELEGRAM_CHAT_ID,
      `✅ Booking *${rideId}* marked as *${newStatus}*`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    logger.error({ event: 'telegram_db_error', rideId, message: err.message });
    bot.sendMessage(TELEGRAM_CHAT_ID, `⚠️ Failed to update booking ${rideId}`);
  }

  bot.answerCallbackQuery(query.id);
});

// ── RabbitMQ consumer with Dead Letter Queue ──────────────────────────────────
async function receiveMessages() {
  try {
    const conn    = await amqp.connect(RABBITMQ_URL || 'amqp://localhost');
    const channel = await conn.createChannel();

    // Main queue
    await channel.assertQueue(MAIN_QUEUE, { durable: true });
    // DLQ — created here so it exists before any messages land in it
    await channel.assertQueue(DLQ, { durable: true });

    channel.prefetch(1);
    logger.info({ event: 'vc_ready', queue: MAIN_QUEUE });

    channel.consume(MAIN_QUEUE, async (msg) => {
      if (!msg) return;

      const booking    = JSON.parse(msg.content.toString());
      const retryCount = parseInt(msg.properties.headers?.['x-retry-count'] || '0', 10);

      logger.info({ event: 'vc_received', bookingId: booking.id, attempt: retryCount + 1 });

      try {
        await sendToTelegram(booking);
        logger.info({ event: 'vc_telegram_sent', bookingId: booking.id });

        // Push to vendor web console in real time
        try {
          socketModule.getIO().to('vendor_room').emit('new_ride', booking);
        } catch (_) { /* console may not be open */ }

        channel.ack(msg);

      } catch (err) {
        logger.error({ event: 'vc_telegram_fail', bookingId: booking.id, attempt: retryCount + 1, message: err.message });

        if (retryCount >= MAX_RETRIES) {
          // ── Route to Dead Letter Queue ──────────────────────────────────
          // Message has failed MAX_RETRIES times (e.g. Telegram is down).
          // We ACK the original (remove from main queue) and publish to DLQ
          // with failure metadata so ops can inspect and replay it manually.
          channel.sendToQueue(DLQ, msg.content, {
            persistent: true,
            headers: {
              ...msg.properties.headers,
              'x-failed-reason':   err.message,
              'x-original-queue':  MAIN_QUEUE,
              'x-failed-at':       new Date().toISOString(),
              'x-retry-count':     retryCount
            }
          });
          channel.ack(msg);
          logger.error({ event: 'vc_dlq_routed', bookingId: booking.id, retries: retryCount });

        } else {
          // ── Re-publish with incremented retry counter ────────────────────
          // We re-publish rather than nack(requeue:true) so the retry count
          // header survives and we don't block the channel head-of-line.
          channel.sendToQueue(MAIN_QUEUE, msg.content, {
            persistent: true,
            headers: { 'x-retry-count': retryCount + 1 }
          });
          channel.ack(msg);
          logger.warn({ event: 'vc_retry_scheduled', bookingId: booking.id, nextAttempt: retryCount + 2 });
        }
      }
    }, { noAck: false });

  } catch (err) {
    logger.error({ event: 'vc_rabbitmq_error', message: err.message });
    setTimeout(receiveMessages, 5000);
  }
}

receiveMessages();
