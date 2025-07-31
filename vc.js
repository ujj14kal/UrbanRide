require('dotenv').config(); // ✅ Load environment variables from .env

const amqp = require('amqplib');
const TelegramBot = require('node-telegram-bot-api');
const mysql = require('mysql2/promise'); // ✅ Use the promise-based version

const { generateInvoice } = require('./invoice'); // ✅ Import invoice generator

// === Environment Variables ===
const RABBITMQ_URL = process.env.RABBITMQ_URL;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// === Initialize Telegram Bot ===
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

// === MySQL Connection ===
let connection;

async function start() {
  try {
    connection = await mysql.createConnection({
      host: process.env.MYSQLHOST,
      user: process.env.MYSQLUSER,
      password: process.env.MYSQLPASSWORD,
      database: process.env.MYSQLDATABASE,
      port: process.env.MYSQLPORT
    });

    console.log('✅ Connected to MySQL');

    // === RabbitMQ Connection ===
    const conn = await amqp.connect(RABBITMQ_URL);
    const channel = await conn.createChannel();

    await channel.assertQueue('ride_status_updates');

    console.log('✅ Waiting for ride status updates...');

    channel.consume('ride_status_updates', async (msg) => {
      if (msg !== null) {
        const { rideId, status } = JSON.parse(msg.content.toString());

        try {
          const [rows] = await connection.execute('SELECT * FROM rides WHERE id = ?', [rideId]);

          if (rows.length === 0) {
            console.log(`❌ Ride ID ${rideId} not found`);
            channel.ack(msg);
            return;
          }

          const booking = rows[0];

          await connection.execute('UPDATE rides SET status = ? WHERE id = ?', [status, rideId]);

          if (status === 'accepted') {
            try {
              await generateInvoice(booking);
            } catch (invoiceErr) {
              console.warn(`⚠️ Invoice generation failed for Ride ID ${rideId}:`, invoiceErr.message);
            }

            // ✅ This always runs regardless of invoice error
            await bot.sendMessage(TELEGRAM_CHAT_ID, `✅ Ride ID ${rideId} marked as accepted.`);
          }

          if (status === 'rejected') {
            await bot.sendMessage(TELEGRAM_CHAT_ID, `❌ Ride ID ${rideId} was rejected.`);
          }

          if (status === 'open_market') {
            await bot.sendMessage(TELEGRAM_CHAT_ID, `📢 Ride ID ${rideId} moved to open market.`);
          }

          channel.ack(msg);
        } catch (err) {
          console.error(`❌ Error processing '${status}' for Ride ID ${rideId}:`, err);
          await bot.sendMessage(TELEGRAM_CHAT_ID, `⚠️ Failed to update booking ${rideId}.`);
          channel.ack(msg);
        }
      }
    });
  } catch (err) {
    console.error('❌ Error starting service:', err);
  }
}

start();

