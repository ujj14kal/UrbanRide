require('dotenv').config(); // ✅ Load environment variables from .env


const amqp = require('amqplib');
const TelegramBot = require('node-telegram-bot-api');
const mysql = require('mysql2/promise'); // ✅ Use the promise-based version

// ✅ CRITICAL CHANGE: Correct import for generateInvoice from invoice.js
const { generateInvoice } = require('./invoice'); 




// === Environment Variables ===
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://localhost';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
// Retaining your preferred environment variable names (without underscores)
const MYSQL_HOST = process.env.MYSQLHOST;
const MYSQL_USER = process.env.MYSQLUSER;
const MYSQL_PASSWORD = process.env.MYSQLPASSWORD;
const MYSQL_DATABASE = process.env.MYSQLDATABASE;
const MYSQL_PORT = process.env.MYSQLPORT || 3306; // Ensure this variable is defined, e.g., in your .env or Railway


if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('❌ Missing Telegram bot token or chat ID environment variables.');
    process.exit(1);
}

// === Telegram Bot Setup ===
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// === MySQL Connection Pool ===
// ✅ Use a connection pool for a more robust connection
const pool = mysql.createPool({
    host: MYSQL_HOST,
    user: MYSQL_USER,
    password: MYSQL_PASSWORD,
    database: MYSQL_DATABASE,
    port: MYSQL_PORT, // ✅ ADDED: Use the MYSQL_PORT variable here
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// ✅ Add an error listener to prevent unhandled promise rejections and crashes
pool.getConnection()
    .then(conn => {
        console.log('✅ Connected to MySQL database via connection pool!');
        conn.release();
    })
    .catch(err => {
        console.error('❌ Failed to connect to MySQL pool:', err);
        process.exit(1);
    });


// === Send Booking to Telegram ===
async function sendToTelegram(booking) {
    const message = `
🚖 *New Ride Booking* 🚖

*Guest Name:* ${booking.guest_name}
*Phone:* ${booking.phone}
*Pickup:* ${booking.pickup}
*Dropoff:* ${booking.dropoff}
*Booking ID:* ${booking.id}
`;

    const options = {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [[
                { text: '✅ Accept', callback_data: `accept_${booking.id}` },
                { text: '❌ Reject', callback_data: `reject_${booking.id}` },
                { text: '📤 Open Market', callback_data: `open_${booking.id}` }
            ]]
        }
    };

    return bot.sendMessage(TELEGRAM_CHAT_ID, message, options);
}

// === Handle Telegram Button Responses ===
bot.on('callback_query', async (query) => {
    const [action, rideId] = query.data.split('_');
    let newStatus;

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
        // ✅ Use the connection pool for the update query
        await pool.query(
            'UPDATE rides SET status = ? WHERE id = ?',
            [newStatus, rideId]
        );
        console.log(`✅ Booking ${rideId} updated to ${newStatus}`);
        bot.sendMessage(TELEGRAM_CHAT_ID, `✅ Booking *${rideId}* marked as *${newStatus}*`, { parse_mode: 'Markdown' });

        if (newStatus === 'accepted') {
            // 🔄 Fetch the booking again to pass complete data to the invoice generator
            const [rows] = await pool.query('SELECT * FROM rides WHERE id = ?', [rideId]);
            const booking = rows[0];

            if (booking) {
                // ✅ Calling the imported generateInvoice function
                await generateInvoice(booking);
                console.log(`🧾 Invoice PDF generated for ride ID ${rideId}`);
            } else {
                console.warn(`⚠️ Booking not found for invoice generation: ID ${rideId}`);
            }
        }
    } catch (err) {
        console.error('❌ DB update error or Invoice generation error:', err); // Updated error message for clarity
        bot.sendMessage(TELEGRAM_CHAT_ID, `⚠️ Failed to update booking ${rideId} or generate invoice.`); // Updated message
    }

    bot.answerCallbackQuery(query.id); // Acknowledge click
});

// === Connect to RabbitMQ & Consume Bookings ===
async function receiveMessages() {
    try {
        const connection = await amqp.connect(RABBITMQ_URL);
        const channel = await connection.createChannel();
        const queue = 'ride_requests';

        await channel.assertQueue(queue, { durable: true });
        console.log('✅ Waiting for booking messages...');

        channel.consume(queue, async (msg) => {
            const booking = JSON.parse(msg.content.toString());
            console.log('📦 Received booking:\n', booking);

            try {
                await sendToTelegram(booking);
                console.log(`📨 Sent booking ID ${booking.id} to Telegram`);
                channel.ack(msg);
            } catch (error) {
                console.error('❌ Failed to send to Telegram:', error?.response?.data || error.message);
                channel.nack(msg, false, true);
            }
        }, { noAck: false });

    } catch (error) {
        console.error('❌ Error connecting to RabbitMQ:', error.message);
    }
}

receiveMessages();

