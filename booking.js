const express = require('express');
const router = express.Router();
const db = require('./db');

router.post('/', (req, res) => {
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
    (guest_name, passengers, email, phone, address, trip_type, pickup, dropoff, date_time, vehicle_type, associated_member) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  const values = [
    guest_name, passengers, email, phone, address, trip_type,
    pickup, dropoff, date_time, vehicle_type, associated_member
  ];

  db.query(sql, values, (err, result) => {
    if (err) {
      console.error("Booking error:", err);
      return res.status(500).send("Database error");
    }
    res.status(201).send({ message: "Booking created successfully", booking_id: result.insertId });
  });
});

module.exports = router;


// GET bookings by phone number
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


