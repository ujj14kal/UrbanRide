const express = require('express');
const router = express.Router();
const db = require('./db'); // ✅ Corrected path
const amqp = require('amqplib');

let channel;
const queue = 'ride_requests';

// ✅ Connect to RabbitMQ
async function connectToRabbitMQ() {
  try {
    const connection = await amqp.connect(process.env.RABBITMQ_URL);
    channel = await connection.createChannel();
    await channel.assertQueue(queue);
    console.log('✅ Connected to RabbitMQ');
  } catch (err) {
    console.error('❌ Failed to connect to RabbitMQ:', err.message);
  }
}
connectToRabbitMQ();

// ✅ POST a new booking
router.post('/', async (req, res) => {
  const { guest_name, phone, pickup, dropoff, associated_member } = req.body;

  try {
    const result = await db.query(
      'INSERT INTO bookings (guest_name, phone, pickup, dropoff, associated_member, status) VALUES (?, ?, ?, ?, ?, ?)',
      [guest_name, phone, pickup, dropoff, associated_member, 'pending']
    );

    const booking = {
      id: result.insertId,
      guest_name,
      phone,
      pickup,
      dropoff,
      associated_member,
      status: 'pending'
    };

    if (channel) {
      channel.sendToQueue(queue, Buffer.from(JSON.stringify(booking)));
    }

    res.status(201).json({ message: 'Booking created', booking });
  } catch (err) {
    console.error('Error creating booking:', err.message);
    res.status(500).json({ error: 'Failed to create booking' });
  }
});

module.exports = router;



