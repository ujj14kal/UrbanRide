const express = require('express');
const router = express.Router();
const db = require('./db');
const amqp = require('amqplib');

const queue = 'ride_requests';

// Send booking to RabbitMQ
async function sendToQueue(booking) {
    try {
        const connection = await amqp.connect('amqp://localhost');
        const channel = await connection.createChannel();
        await channel.assertQueue(queue, { durable: true });
        channel.sendToQueue(queue, Buffer.from(JSON.stringify(booking)), { persistent: true });
        console.log('📤 Booking sent to queue:', booking.id);
        await channel.close();
        await connection.close();
    } catch (err) {
        console.error('❌ Failed to send to queue:', err);
    }
}

// POST /api/bookings
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

    if (!guest_name || !phone || !pickup || !dropoff || !date_time || !vehicle_type) {
        return res.status(400).json({ error: 'Missing fields' });
    }

    try {
        const result = await db.execute(
            `INSERT INTO rides 
            (guest_name, passengers, email, phone, address, trip_type, pickup, dropoff, date_time, vehicle_type, associated_member, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
            [guest_name, passengers, email, phone, address, trip_type, pickup, dropoff, date_time, vehicle_type, associated_member]
        );

        const booking = {
            id: result.insertId,
            guest_name,
            phone,
            pickup,
            dropoff
        };

        await sendToQueue(booking);
        res.status(201).json({ success: true, id: result.insertId });
    } catch (err) {
        console.error('❌ Error inserting booking:', err);
        res.status(500).json({ error: 'Failed to create booking' });
    }
});

module.exports = router;


