const amqp = require('amqplib');
const express = require('express');
const router = express.Router();
const db = require('./db'); // Assuming db.js is correctly configured for Railway MySQL

// Load environment variables for Render deployment
// (This is usually done in your main app.js or server.js,
// but explicitly calling it here ensures env vars are available
// if this module is loaded before the main app's dotenv call.
// However, the best practice is to load dotenv once at the application entry point.)
// require('dotenv').config(); // <-- This line should typically be in your main app.js/server.js


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

    // FIX: Re-typed SQL query using template literals to eliminate potential hidden syntax errors
    const sql = `
        INSERT INTO rides (
            guest_name, passengers, email, phone, address, trip_type,
            pickup, dropoff, date_time, vehicle_type, associated_member, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

  const values = [
    guest_name, passengers, email, phone, address, trip_type,
    pickup, dropoff, date_time, vehicle_type, associated_member, 'pending'
  ];

  db.query(sql, values, async (err, result) => {
    if (err) {
      console.error("Booking error:", err);
      return res.status(500).send("Database error"); // Still sending plain text, but fix SQL first
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

    let conn; // Declare conn outside try block for finally
    try {
        // --- FIX: Connect to Railway RabbitMQ using environment variable ---
        const RABBITMQ_URL = process.env.RABBITMQ_URL;
        if (!RABBITMQ_URL) {
            console.error("❌ RABBITMQ_URL environment variable is not set. Cannot connect to RabbitMQ.");
            // Even if RabbitMQ connection fails, we can still respond that booking was saved
            return res.status(500).send({ message: 'Booking saved, but RabbitMQ URL is missing.' });
        }

        conn = await amqp.connect(RABBITMQ_URL); // <--- CORRECTED LINE!
        const channel = await conn.createChannel();
        const queue = 'ride_requests'; // Use the correct queue name

        await channel.assertQueue(queue, { durable: true });
        channel.sendToQueue(queue, Buffer.from(JSON.stringify(bookingData)), { persistent: true }); // Use 'queue' variable


      console.log('📤 Sent booking to vendor queue');

      res.status(201).send({ message: "Booking created and sent to vendor", booking_id });

    } catch (error) {
      console.error('❌ Failed to notify vendor via RabbitMQ:', error);
      res.status(500).send({ message: 'Booking saved, but failed to notify vendor.' });
    } finally { // Ensure connection is closed even if there's an error
        if (conn) {
            setTimeout(() => {
                conn.close();
            }, 500); // Give a little time for message to be sent
        }
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

