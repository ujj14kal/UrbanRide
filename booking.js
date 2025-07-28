const amqp = require('amqplib');
const express = require('express');
const router = express.Router();
const db = require('./db');

// ✅ POST /api/bookings
router.post('/', async (req, res) => {
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
    associated_member
  } = req.body;

  const sql = `INSERT INTO rides 
    (guest_name, passengers, email, phone, address, trip_type, pickup, dropoff, date_time, vehicle_type, associated_member, status) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  const values = [
    guest_name, passengers, email, phone, address, trip_type,
    pickup, dropoff, date_time, vehicle_type, associated_member, 'pending'
  ];

  db.query(sql, values, async (err, result) => {
    if (err) {
      console.error("Booking error:", err);
      return res.status(500).send("Database error");
    }

    const booking_id = result.insertId;

    const bookingData = {
      id: booking_id,
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
      associated_member
    };

    try {
      const conn = await amqp.connect('amqp://localhost');
      const channel = await conn.createChannel();
      const queue = 'ride_requests';

      await channel.assertQueue('booking_requests', { durable: true });
channel.sendToQueue('booking_requests', Buffer.from(JSON.stringify(bookingData)), { persistent: true });


      console.log('📤 Sent booking to vendor queue');

      res.status(201).send({ message: "Booking created and sent to vendor", booking_id });

      setTimeout(() => {
        conn.close();
      }, 500);
    } catch (error) {
      console.error('❌ Failed to notify vendor:', error);
      res.status(500).send({ message: 'Booking saved, but failed to notify vendor.' });
    }
  });
});

// ✅ GET bookings by phone number
router.get('/by-phone/:phone', (req, res) => {
  const phone = req.params.phone;

  const sql = `SELECT * FROM rides WHERE phone = ? ORDER BY id DESC`;

  db.query(sql, [phone], (err, results) => {
    if (err) {
      console.error('Error fetching bookings:', err);
      return res.status(500).send({ message: 'Server error' });
    }

    res.status(200).send(results);
  });
});

// ✅ GET booking by ID (used in frontend and vendor)
router.get('/by-id/:id', (req, res) => {
  const bookingId = req.params.id;

  db.query(
    'SELECT id, guest_name, pickup, dropoff, status AS vendor_status FROM rides WHERE id = ?',
    [bookingId],
    (err, results) => {
      if (err) {
        console.error('Error fetching booking by ID:', err);
        return res.status(500).json({ error: 'Database error' });
      }
      res.json(results);
    }
  );
});

// ✅ DELETE a booking by ID
router.delete('/:booking_id', (req, res) => {
  const bookingId = req.params.booking_id;
  console.log('DELETE request for booking ID:', bookingId);

  const sql = 'DELETE FROM rides WHERE id = ?';
  db.query(sql, [bookingId], (err, result) => {
    if (err) {
      console.error('Error deleting booking:', err);
      return res.status(500).send({ message: 'Failed to cancel booking' });
    }

    if (result.affectedRows === 0) {
      return res.status(404).send({ message: 'Booking not found' });
    }

    res.send({ message: 'Booking cancelled successfully' });
  });
});

module.exports = router;




