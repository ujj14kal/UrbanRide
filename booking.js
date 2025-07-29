const express = require('express');
const router = express.Router();
const db = require('./db');
const amqp = require('amqplib');

let channel;

// ✅ Connect to RabbitMQ once at startup
(async () => {
  try {
    const connection = await amqp.connect(process.env.RABBITMQ_URL);
    channel = await connection.createChannel();
    await channel.assertQueue('ride_requests');
    console.log('✅ Connected to RabbitMQ');
  } catch (err) {
    console.error('❌ Failed to connect to RabbitMQ:', err.message);
  }
})();

// ✅ Book a ride
router.post('/', async (req, res) => {
  const { guestName, phone, pickup, dropoff, associatedMember } = req.body;

  if (!guestName || !phone || !pickup || !dropoff || !associatedMember) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  try {
    const [result] = await db.query(
      'INSERT INTO rides (guest_name, phone, pickup, dropoff, associated_member, status) VALUES (?, ?, ?, ?, ?, ?)',
      [guestName, phone, pickup, dropoff, associatedMember, 'pending']
    );

    const rideId = result.insertId;

    const rideData = {
      id: rideId,
      guestName,
      phone,
      pickup,
      dropoff,
      associatedMember,
      status: 'pending'
    };

    // ✅ Send ride to RabbitMQ
    if (channel) {
      channel.sendToQueue('ride_requests', Buffer.from(JSON.stringify(rideData)));
    }

    res.status(201).json({ success: true, ride: rideData });
  } catch (err) {
    console.error('Error creating ride:', err); // log full error
    res.status(500).json({ error: 'Failed to create booking' });
  }
});

// ✅ Get ride by phone or ID
router.get('/', async (req, res) => {
  const { phone, id } = req.query;

  if (!phone && !id) {
    return res.status(400).json({ error: 'Phone or ID required' });
  }

  try {
    let [rides];
    if (id) {
      [rides] = await db.query('SELECT * FROM rides WHERE id = ?', [id]);
    } else {
      [rides] = await db.query('SELECT * FROM rides WHERE phone = ?', [phone]);
    }

    if (rides.length === 0) {
      return res.status(404).json({ error: 'No ride found' });
    }

    res.json(rides);
  } catch (err) {
    console.error('Error fetching ride:', err);
    res.status(500).json({ error: 'Failed to fetch ride' });
  }
});

// ✅ Cancel a ride
router.delete('/:id', async (req, res) => {
  const rideId = req.params.id;

  try {
    const [result] = await db.query('UPDATE rides SET status = ? WHERE id = ?', ['cancelled', rideId]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Ride not found' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Error cancelling ride:', err);
    res.status(500).json({ error: 'Failed to cancel ride' });
  }
});

module.exports = router;




