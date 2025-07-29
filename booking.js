const express = require('express');
const router = express.Router();
const db = require('../db');
const amqp = require('amqplib');
const axios = require('axios');

// Telegram Bot Setup
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8313019141:AAFQSebv9QQSmvCzZni7-RnSM2ovcn3JKvs';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7596524752';

// Booking endpoint
router.post('/book', async (req, res) => {
  const {
    guest_name,
    phone,
    pickup,
    dropoff,
    vehicle_type,
    date_time,
    member
  } = req.body;

  try {
    const [result] = await db.execute(
      'INSERT INTO bookings (guest_name, phone, pickup, dropoff, vehicle_type, date_time, member, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [guest_name, phone, pickup, dropoff, vehicle_type, date_time, member, 'pending']
    );

    const booking_id = result.insertId;
    console.log('✅ Booking saved with ID:', booking_id);

    // Prepare booking data
    const bookingData = {
      id: booking_id,
      guest_name,
      phone,
      pickup,
      dropoff,
      vehicle_type,
      date_time,
      member,
      status: 'pending'
    };

    // Send to RabbitMQ
    const connection = await amqp.connect(process.env.RABBITMQ_URL || 'amqp://localhost');
    const channel = await connection.createChannel();
    const queue = 'ride_requests';

    await channel.assertQueue(queue, { durable: false });
    await channel.sendToQueue(queue, Buffer.from(JSON.stringify(bookingData)));
    console.log('📤 Sent booking to vendor queue');

    // Send Telegram notification
    const message = `
🆕 New Booking #${booking_id}
👤 Guest: ${guest_name}
📍 From: ${pickup}
📍 To: ${dropoff}
🚗 Vehicle: ${vehicle_type}
📞 Phone: ${phone}
📅 Date: ${date_time}
`;

    try {
      console.log('📤 Attempting to send Telegram message...');
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: TELEGRAM_CHAT_ID,
        text: message
      });
      console.log('✅ Telegram message sent!');
    } catch (err) {
      console.error('❌ Telegram send failed:', err.response?.data || err.message);
    }

    res.status(200).json({ id: booking_id, message: 'Booking created successfully' });
  } catch (err) {
    console.error('❌ Booking error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
