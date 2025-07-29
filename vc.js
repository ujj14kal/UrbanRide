const amqp = require('amqplib');
const axios = require('axios');

// Telegram config
const TELEGRAM_BOT_TOKEN = '8313019141:AAFQSebv9QQSmvCzZni7-RnSM2ovcn3JKvs';
const TELEGRAM_CHAT_ID = '7596524752'; // Replace with your actual Telegram chat ID

// Send booking message to Telegram
function sendToTelegram(booking) {
    const message = `
🚖 *New Ride Booking Received* 🚖

*Guest Name:* ${booking.guest_name}
*Phone:* ${booking.phone}
*Pickup:* ${booking.pickup}
*Dropoff:* ${booking.dropoff}
*Booking ID:* ${booking.id}

📲 Reply with:
/accept_${booking.id}
/reject_${booking.id}
/open_${booking.id}
`;

    return axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'Markdown'
    });
}

// Connect to RabbitMQ and consume messages
async function receiveMessages() {
    try {
        const connection = await amqp.connect('amqp://localhost');
        const channel = await connection.createChannel();
        const queue = 'ride_requests';

        await channel.assertQueue(queue, { durable: false });

        console.log('✅ Waiting for booking messages...');

        channel.consume(queue, async (msg) => {
            const booking = JSON.parse(msg.content.toString());
            console.log('\n📦 Received booking:\n', booking);

            try {
                await sendToTelegram(booking);
                console.log(`📨 Sent booking ID ${booking.id} to Telegram`);
                channel.ack(msg);
            } catch (error) {
                console.error('❌ Failed to send to Telegram:', error);
                channel.nack(msg, false, true); // Retry if sending fails
            }
        }, { noAck: false });

    } catch (error) {
        console.error('❌ Error connecting to RabbitMQ:', error);
    }
}

receiveMessages();
