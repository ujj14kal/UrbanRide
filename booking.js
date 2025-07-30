const express = require('express');
const router = express.Router();
const pool = require('./db');
const amqp = require('amqplib');

let channel, connection;

// Connect to RabbitMQ
async function connectQueue() {
  try {
    connection = await amqp.connect(process.env.RABBITMQ_URL);
    channel = await connection.createChannel();
    await channel.assertQueue('ride_requests');
    console.log('Connected to RabbitMQ');
  } catch (error) {
    console.error('RabbitMQ connection error:', error.message);
  }
}
connectQueue();

// POST /api/bookings — Create new booking
router.post('/', async (req, res) => {
  try {
    const {
      guest_name,
      passengers,
      email,
      phone,
      address,
      trip_type,
      pickup,
      dropoff,
      date_time,
      vehicle_type,
      status, // make sure this is passed!
      associated_member,
    } = req.body;

    const sql = `
      INSERT INTO rides 
      (guest_name, passengers, email, phone, address, trip_type, pickup, dropoff, date_time, vehicle_type, status, associated_member) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const values = [
      guest_name,
      passengers,
      email,
      phone,
      address,
      trip_type,
      pickup,
      dropoff,
      date_time,
      vehicle_type,
      status, // ✅ correctly placed
      associated_member,
    ];

    const [result] = await pool.query(sql, values);

    const insertedBooking = {
      id: result.insertId,
      ...req.body,
    };

    // Send booking to RabbitMQ
    if (channel) {
      channel.sendToQueue('ride_requests', Buffer.from(JSON.stringify(insertedBooking)));
      console.log('Booking sent to queue');
    }

    res.status(201).json({ success: true, booking: insertedBooking });
  } catch (error) {
    console.error('Booking Error:', error.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// GET /api/bookings?phone=xxx or ?id=xxx
router.get('/', async (req, res) => {
  const { phone, id } = req.query;
  try {
    let sql = 'SELECT * FROM rides WHERE ';
    let param;

    if (phone) {
      sql += 'phone = ? ORDER BY id DESC';
      param = phone;
    } else if (id) {
      sql += 'id = ?';
      param = id;
    } else {
      return res.status(400).json({ success: false, error: 'Phone or ID required' });
    }

    const [rows] = await pool.query(sql, [param]);
    res.json({ success: true, bookings: rows });
  } catch (error) {
    console.error('Fetch Error:', error.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// DELETE /api/bookings/:id — Cancel booking
router.delete('/:id', async (req, res) => {
  try {
    const bookingId = req.params.id;
    const sql = 'DELETE FROM rides WHERE id = ?';
    await pool.query(sql, [bookingId]);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete Error:', error.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

module.exports = router;



