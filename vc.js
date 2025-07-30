const amqp = require('amqplib');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const mysql = require('mysql2');

// Telegram config
const TELEGRAM_BOT_TOKEN = '8313019141:AAFQSebv9QQSmvCzZni7-RnSM2ovcn3JKvs';
const TELEGRAM_CHAT_ID = '7596524752'; // Your Telegram user ID
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// MySQL config
const db = mysql.createConnection({
    host: 'your_host',       // e.g., 'localhost' or Railway host
    user: 'your_user',
    password: 'your_password',
    database: 'your_database'
});

// Send booking message to Telegram
function sendToTelegram(booking) {
    const message = `
🚖 *New Ride Booking Received* 🚖

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

// Handle Telegram button responses
bot.on('callback_query', (query) => {
    const action = query.data.split('_')[0];
    const rideId = query.data.split('_')[1];
    let newStatus;

    if (action === 'accept') newStatus = 'accepted';
    else if (action === 'reject') newStatus = 'rejected';
    else if (action === 'open') newStatus = 'open_market';

    if (newStatus) {
        db.query(
            'UPDATE rides SET status = ? WHERE id = ?',
            [newStatus, rideId],
            (err, result) => {
                if (err) {
                    console.error('❌ DB update error:', err);
                    bot.sendMessage(TELEGRAM_CHAT_ID, `⚠️ Failed to update booking ${rideId}`);
                } else {
                    console.log(`✅ Booking ${rideId} updated to ${newStatus}`);
                    bot.sendMessage(TELEGRAM_CHAT_ID, `✅ Booking *${rideId}* marked as *${newStatus}*`, { parse_mode: 'Markdown' });
                }
            }
        );
    }

    bot.answerCallbackQuery(query.id); // Acknowledge button press
});

// Connect to RabbitMQ and consume messages
async function receiveMessages() {
    try {
        const connection = await amqp.connect('amqp://localhost');
        const channel = await connection.createChannel();
        const queue = 'ride_requests';

        await channel.assertQueue(queue, { durable: true });

        console.log('✅ Waiting for booking messages...');

        channel.consume(queue, async (msg) => {
            const booking = JSON.parse(msg.content.toString());
            console.log('\n📦 Received booking:\n', booking);

            try {
                await sendToTelegram(booking);
                console.log(`📨 Sent booking ID ${booking.id} to Telegram`);
                channel.ack(msg);
            } catch (error) {
                console.error('❌ Failed to send to Telegram:', error.response?.data || error.message);
                channel.nack(msg, false, true);
            }
        }, { noAck: false });

    } catch (error) {
        console.error('❌ Error connecting to RabbitMQ:', error);
    }
}

receiveMessages();

