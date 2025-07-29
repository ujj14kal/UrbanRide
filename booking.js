// booking.js
const express = require('express');
const router = express.Router();
const db = require('./db');
const amqp = require('amqplib');

let channel;
const queue = 'ride_requests';

(async () => {
  try {
    const connection = await amqp.connect(process.env.CLOUDAMQP_URL || 'amqp://localhost');
    channel = await connection.createChannel();
    await channel.assertQueue(queue);
    console.log('✅ Connected to RabbitMQ');
  } catch (err) {
    console.error('❌ Failed to connect to RabbitMQ:', err.message);
  }
})();

// POST a new booking
router.post('/', async (req, res) => {
  const { guestName, phone, pickup, dropoff, associatedMember } = req.body;

  try {
    const [result] = await db.query(
      'INSERT INTO bookings (guestName, phone, pickup, dropoff, associatedMember, status) VALUES (?, ?, ?, ?, ?, ?)',
      [guestName, phone, pickup, dropoff, associatedMember, 'pending']
    );

    const booking = {
      id: result.insertId,
      guestName,
      phone,
      pickup,
      dropoff,
      associatedMember,
      status: 'pending'
    };

    if (channel) {
      channel.sendToQueue(queue, Buffer.from(JSON.stringify(booking)));
      console.log('📨 Sent booking to queue:', booking);
    }

    res.json(booking);
  } catch (err) {
    console.error('Error creating booking:', err.message);
    res.status(500).json({ error: 'Failed to create booking' });
  }
});

// GET bookings by phone or ID
router.get('/', async (req, res) => {
  const { phone, id } = req.query;

  try {
    let results;
    if (id) {
      [results] = await db.query('SELECT * FROM bookings WHERE id = ?', [id]);
    } else if (phone) {
      [results] = await db.query('SELECT * FROM bookings WHERE phone = ?', [phone]);
    } else {
      return res.status(400).json({ error: 'Provide phone or id' });
    }

    res.json(results);
  } catch (err) {
    console.error('Error fetching booking:', err.message);
    res.status(500).json({ error: 'Failed to fetch booking' });
  }
});

// DELETE a booking by ID
router.delete('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    await db.query('DELETE FROM bookings WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting booking:', err.message);
    res.status(500).json({ error: 'Failed to delete booking' });
  }
});

module.exports = router;


