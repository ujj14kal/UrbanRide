// vc.js — Vendor Consumer
// Consumes ride_requests from RabbitMQ, notifies vendor via Telegram inline buttons,
// and pushes real-time status updates via Socket.io when the vendor responds.

require('dotenv').config();

const amqp        = require('amqplib');
const TelegramBot = require('node-telegram-bot-api');
const mysql       = require('mysql2/promise');
const socketModule = require('./socket');
const { statusCache, bookingCache } = require('./cache');

// ── Environment ───────────────────────────────────────────────────────────────
const {
  RABBITMQ_URL,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  MYSQLHOST,
  MYSQLUSER,
  MYSQLPASSWORD,
  MYSQLDATABASE,
  MYSQLPORT
} = process.env;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error('❌ Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID env vars.');
  process.exit(1);
}

// ── Telegram bot ──────────────────────────────────────────────────────────────
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// ── MySQL connection pool (separate from the one in db.js) ────────────────────
const pool = mysql.createPool({
  host:             MYSQLHOST,
  user:             MYSQLUSER,
  password:         MYSQLPASSWORD,
  database:         MYSQLDATABASE,
  port:             MYSQLPORT,
  ssl:              { rejectUnauthorized: false },
  waitForConnections: true,
  connectionLimit:  10,
  queueLimit:       0
});

pool.getConnection()
  .then(conn => {
    console.log('✅ vc.js connected to MySQL pool');
    conn.release();
  })
  .catch(err => {
    console.error('❌ vc.js MySQL pool error:', err);
    process.exit(1);
  });

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
    action === 'accept' ? 'accepted'   :
    action === 'reject' ? 'rejected'   :
    action === 'open'   ? 'open_market': null;

  if (!newStatus) return;

  try {
    await pool.query(
      'UPDATE rides SET status = ? WHERE id = ?',
      [newStatus, rideId]
    );

    // Invalidate caches so next HTTP poll fetches fresh data
    statusCache.del(`status_${rideId}`);
    bookingCache.del(`booking_${rideId}`);

    // ✅ Real-time push — all clients watching this booking get instant update
    try {
      const io = socketModule.getIO();
      io.to(`booking_${rideId}`).emit('status_update', {
        bookingId: rideId,
        status:    newStatus
      });
      console.log(`📡 Socket pushed status_update for booking ${rideId}: ${newStatus}`);
    } catch (socketErr) {
      // Non-fatal — client will fall back to HTTP poll
      console.warn('⚠️  Socket emit failed:', socketErr.message);
    }

    console.log(`✅ Booking ${rideId} → ${newStatus}`);
    bot.sendMessage(
      TELEGRAM_CHAT_ID,
      `✅ Booking *${rideId}* marked as *${newStatus}*`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('❌ DB update error:', err);
    bot.sendMessage(TELEGRAM_CHAT_ID, `⚠️ Failed to update booking ${rideId}`);
  }

  bot.answerCallbackQuery(query.id);
});

// ── RabbitMQ consumer ─────────────────────────────────────────────────────────
async function receiveMessages() {
  try {
    const conn    = await amqp.connect(RABBITMQ_URL || 'amqp://localhost');
    const channel = await conn.createChannel();
    const queue   = 'ride_requests';

    await channel.assertQueue(queue, { durable: true });
    channel.prefetch(1);   // Process one message at a time
    console.log('✅ vc.js waiting for booking messages…');

    channel.consume(queue, async (msg) => {
      if (!msg) return;

      const booking = JSON.parse(msg.content.toString());
      console.log(`📦 Received booking ID ${booking.id}`);

      try {
        await sendToTelegram(booking);
        console.log(`📨 Booking ${booking.id} sent to Telegram`);

        // Push to vendor web console in real time
        try {
          socketModule.getIO().to('vendor_room').emit('new_ride', booking);
        } catch (_) { /* non-fatal — console may not be open */ }

        channel.ack(msg);
      } catch (err) {
        console.error('❌ Telegram send failed:', err?.response?.data || err.message);
        channel.nack(msg, false, true);  // requeue
      }
    }, { noAck: false });

  } catch (err) {
    console.error('❌ RabbitMQ consumer error:', err.message);
    setTimeout(receiveMessages, 5000);   // retry after 5 s
  }
}

receiveMessages();
