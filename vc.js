require('dotenv').config();

const amqp = require('amqplib');
const TelegramBot = require('node-telegram-bot-api');
const mysql = require('mysql2/promise');
const generateAndSendInvoice = require('./invoice');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

const pool = mysql.createPool({
  host: process.env.MYSQLHOST,
  user: process.env.MYSQLUSER,
  password: process.env.MYSQLPASSWORD,
  database: process.env.MYSQLDATABASE,
  port: process.env.MYSQLPORT
});

(async () => {
  try {
    const connection = await amqp.connect(process.env.RABBITMQ_URL);
    const channel = await connection.createChannel();
    const queue = 'ride_requests';

    await channel.assertQueue(queue, { durable: false });

    console.log('✅ Waiting for messages in', queue);

    channel.consume(queue, async (msg) => {
      const booking = JSON.parse(msg.content.toString());
      console.log('📥 Received booking:', booking);

      const message = `🚕 New Ride Request\n\nName: ${booking.guest_name}\nPhone: ${booking.phone}\nPickup: ${booking.pickup}\nDropoff: ${booking.dropoff}\nDate/Time: ${booking.date_time}`;

      const options = {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Accept', callback_data: `accept_${booking.id}` },
              { text: '❌ Reject', callback_data: `reject_${booking.id}` },
              { text: '📤 Open Market', callback_data: `open_market_${booking.id}` }
            ]
          ]
        }
      };

      await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, message, options);
      channel.ack(msg);
    });
  } catch (error) {
    console.error('❌ AMQP or DB Error:', error);
  }
})();

// Telegram button responses
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const [action, rideId] = query.data.split('_');
  let newStatus = '';

  switch (action) {
    case 'accept':
      newStatus = 'accepted';
      break;
    case 'reject':
      newStatus = 'rejected';
      break;
    case 'open':
      newStatus = 'open_market';
      break;
    default:
      return;
  }

  try {
    const [result] = await pool.query('UPDATE rides SET status = ? WHERE id = ?', [newStatus, rideId]);
    console.log(`✅ Booking ID ${rideId} updated to '${newStatus}'`);

    await bot.sendMessage(chatId, `ℹ️ Ride ID ${rideId} marked as '${newStatus}'`);

    if (newStatus === 'accepted') {
      const [rows] = await pool.query('SELECT * FROM rides WHERE id = ?', [rideId]);
      const booking = rows[0];

      if (booking) {
        console.log(`📄 Generating invoice for Booking ID ${booking.id}`);
        await generateAndSendInvoice(booking);
        console.log(`📧 Invoice sent for Booking ID ${booking.id}`);
      } else {
        console.warn(`⚠️ No booking found for ID ${rideId}`);
      }
    }
  } catch (err) {
    console.error(`❌ Error processing '${newStatus}' for Ride ID ${rideId}:`, err);
  }
});


