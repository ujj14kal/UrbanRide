// booking.js — Booking CRUD router
// Uses express-validator for input sanitisation before touching the DB.

const express                                 = require('express');
const { body, validationResult }              = require('express-validator');
const router                                  = express.Router();
const pool                                    = require('./db');
const amqp                                    = require('amqplib');
const { statusCache, bookingCache }           = require('./cache');

let channel, connection;

// ── RabbitMQ connection with retry ────────────────────────────────────────────
async function connectQueue() {
  try {
    connection = await amqp.connect(process.env.RABBITMQ_URL);

    connection.on('error', (err) => {
      console.error('❌ RabbitMQ error:', err.message);
      setTimeout(connectQueue, 5000);
    });
    connection.on('close', () => {
      console.error('❌ RabbitMQ closed — reconnecting…');
      setTimeout(connectQueue, 5000);
    });

    channel = await connection.createChannel();
    await channel.assertQueue('ride_requests', { durable: true });
    console.log('✅ Connected to RabbitMQ');
  } catch (err) {
    console.error('❌ RabbitMQ connection failed:', err.message);
    setTimeout(connectQueue, 5000);
  }
}
connectQueue();

// ── Validation rules ──────────────────────────────────────────────────────────
const bookingValidation = [
  body('guest_name')
    .trim()
    .notEmpty().withMessage('Guest name is required')
    .isLength({ max: 100 }).withMessage('Name too long'),

  body('phone')
    .trim()
    .notEmpty().withMessage('Phone number is required')
    .matches(/^[+\d\s\-()]{7,20}$/).withMessage('Invalid phone number'),

  body('email')
    .optional({ checkFalsy: true })
    .isEmail().withMessage('Invalid email address')
    .normalizeEmail(),

  body('pickup')
    .trim()
    .notEmpty().withMessage('Pickup location is required'),

  body('dropoff')
    .trim()
    .notEmpty().withMessage('Dropoff location is required'),

  body('date_time')
    .notEmpty().withMessage('Date & time is required')
    .isISO8601().withMessage('Invalid date/time format'),

  body('vehicle_type')
    .isIn(['Sedan', 'SUV', 'Luxury', 'Tempo Traveller'])
    .withMessage('Invalid vehicle type'),

  body('passengers')
    .optional()
    .isInt({ min: 1, max: 50 }).withMessage('Passengers must be 1–50'),

  body('trip_type')
    .optional()
    .isIn(['Local', 'Outstation']).withMessage('Invalid trip type'),
];

// ── POST /api/bookings — Create booking ───────────────────────────────────────
router.post('/', bookingValidation, async (req, res) => {
  // Return structured validation errors
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ success: false, errors: errors.array() });
  }

  try {
    const {
      guest_name, passengers, email, phone, address,
      trip_type, pickup, dropoff, date_time,
      vehicle_type, associated_member
    } = req.body;

    const sql = `
      INSERT INTO rides
        (guest_name, passengers, email, phone, address, trip_type,
         pickup, dropoff, date_time, vehicle_type, status, associated_member)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const values = [
      guest_name, passengers, email, phone, address, trip_type,
      pickup, dropoff, date_time, vehicle_type, 'pending', associated_member
    ];

    const [result] = await pool.query(sql, values);

    const insertedBooking = { id: result.insertId, ...req.body, status: 'pending' };

    // Warm the cache immediately so the first status poll is a cache hit
    statusCache.set(`status_${result.insertId}`, 'pending');

    // Publish to RabbitMQ for async vendor notification
    if (channel) {
      channel.sendToQueue(
        'ride_requests',
        Buffer.from(JSON.stringify(insertedBooking)),
        { persistent: true }   // survives broker restart
      );
      console.log(`✅ Booking ${insertedBooking.id} queued for vendor notification`);
    } else {
      console.error('❌ RabbitMQ channel unavailable — booking not queued');
    }

    res.status(201).json({ success: true, booking: insertedBooking });
  } catch (err) {
    console.error('❌ Booking error:', err.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ── GET /api/bookings/by-phone/:phone ─────────────────────────────────────────
router.get('/by-phone/:phoneNumber', async (req, res) => {
  const { phoneNumber } = req.params;
  if (!phoneNumber) {
    return res.status(400).json({ success: false, error: 'Phone number required.' });
  }
  try {
    const [rows] = await pool.query(
      'SELECT * FROM rides WHERE phone = ? ORDER BY id DESC',
      [phoneNumber]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'No bookings found for this number.' });
    }
    res.json(rows);
  } catch (err) {
    console.error('❌ Fetch error:', err.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ── GET /api/bookings?phone=&id= ──────────────────────────────────────────────
router.get('/', async (req, res) => {
  const { phone, id } = req.query;
  try {
    let sql, param;

    if (phone) {
      sql   = 'SELECT * FROM rides WHERE phone = ? ORDER BY id DESC';
      param = phone;
    } else if (id) {
      // Try booking cache first
      const cached = bookingCache.get(`booking_${id}`);
      if (cached) return res.json({ bookings: [cached], source: 'cache' });

      sql   = 'SELECT * FROM rides WHERE id = ?';
      param = id;
    } else {
      return res.status(400).json({ success: false, error: 'Phone or ID required' });
    }

    const [rows] = await pool.query(sql, [param]);

    // Cache individual booking lookup
    if (id && rows.length > 0) {
      bookingCache.set(`booking_${id}`, rows[0]);
    }

    res.json({ bookings: rows });
  } catch (err) {
    console.error('❌ Fetch error:', err.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ── PATCH /api/bookings/:id/cancel — Rider cancels an active booking ─────────
// Sets status to 'cancelled' (keeps the record in history) and invalidates caches.
router.patch('/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await pool.query(
      "UPDATE rides SET status = 'cancelled' WHERE id = ? AND status IN ('pending', 'open_market')",
      [id]
    );

    if (result.affectedRows === 0) {
      // Either not found or already actioned — don't allow cancelling an accepted ride
      return res.status(409).json({ success: false, error: 'Ride cannot be cancelled in its current state.' });
    }

    // Evict from caches
    statusCache.del(`status_${id}`);
    bookingCache.del(`booking_${id}`);

    res.json({ success: true, status: 'cancelled' });
  } catch (err) {
    console.error('❌ Cancel error:', err.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ── DELETE /api/bookings/:id ──────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM rides WHERE id = ?', [id]);

    // Evict from caches
    statusCache.del(`status_${id}`);
    bookingCache.del(`booking_${id}`);

    res.json({ success: true });
  } catch (err) {
    console.error('❌ Delete error:', err.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

module.exports = router;
