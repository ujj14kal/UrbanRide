// booking.js — Booking CRUD router
//
// FAANG patterns in this file:
//   • express-validator — structured 422 errors, never trust client input
//   • Idempotency key   — X-Idempotency-Key header prevents duplicate bookings
//                         on network retry; cached for 24 h
//   • Cache warm-up     — status cached on INSERT so first poll is always a hit
//   • RabbitMQ publish  — persistent messages survive broker restart
//   • Cancel endpoint   — PATCH /:id/cancel sets status='cancelled' (keeps history)
//                         and pushes socket events to rider + vendor in real time
//   • Structured logger — every path logs a typed event object for aggregation

const express                                       = require('express');
const { body, validationResult }                    = require('express-validator');
const router                                        = express.Router();
const pool                                          = require('./db');
const amqp                                          = require('amqplib');
const { statusCache, bookingCache, idempotencyCache } = require('./cache');
const logger                                        = require('./logger');
const socketModule                                  = require('./socket');

let channel, connection;

// ── RabbitMQ connection with exponential-ish retry ───────────────────────────
async function connectQueue() {
  try {
    connection = await amqp.connect(process.env.RABBITMQ_URL);

    connection.on('error', (err) => {
      logger.error({ event: 'rabbitmq_error', message: err.message });
      setTimeout(connectQueue, 5000);
    });
    connection.on('close', () => {
      logger.warn({ event: 'rabbitmq_closed' });
      setTimeout(connectQueue, 5000);
    });

    channel = await connection.createChannel();
    await channel.assertQueue('ride_requests', { durable: true });
    logger.info({ event: 'rabbitmq_connected' });
  } catch (err) {
    logger.error({ event: 'rabbitmq_connect_failed', message: err.message });
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
  // Structured validation errors
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    logger.warn({ event: 'booking_validation_failed', errors: errors.array() });
    return res.status(422).json({ success: false, errors: errors.array() });
  }

  // ── Idempotency check ─────────────────────────────────────────────────────
  // If the client supplies X-Idempotency-Key and we've seen it before, return
  // the original response without touching the DB or RabbitMQ.
  // This makes retries safe: double-tap "Book" or a flaky network can't create
  // duplicate bookings.
  const idemKey = req.headers['x-idempotency-key'];
  if (idemKey) {
    const cached = idempotencyCache.get(`idem_${idemKey}`);
    if (cached) {
      logger.info({ event: 'idempotency_hit', key: idemKey, reqId: req.id });
      return res.status(200).json(cached);
    }
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
    const bookingId = result.insertId;

    const insertedBooking = { id: bookingId, ...req.body, status: 'pending' };

    // Cache warm-up: first status poll is always a cache hit
    statusCache.set(`status_${bookingId}`, 'pending');

    // Publish to RabbitMQ for async vendor notification
    if (channel) {
      channel.sendToQueue(
        'ride_requests',
        Buffer.from(JSON.stringify(insertedBooking)),
        { persistent: true }  // survives broker restart
      );
    } else {
      logger.error({ event: 'rabbitmq_unavailable', bookingId, reqId: req.id });
    }

    const response = { success: true, booking: insertedBooking };

    // Store under idempotency key so retries get the same response
    if (idemKey) {
      idempotencyCache.set(`idem_${idemKey}`, response);
    }

    logger.info({ event: 'booking_created', bookingId, phone, reqId: req.id });
    res.status(201).json(response);
  } catch (err) {
    logger.error({ event: 'booking_error', message: err.message, reqId: req.id });
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
    // Return empty array (not 404) — caller handles the empty state
    res.json(rows);
  } catch (err) {
    logger.error({ event: 'fetch_by_phone_error', message: err.message });
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
      const cached = bookingCache.get(`booking_${id}`);
      if (cached) return res.json({ bookings: [cached], source: 'cache' });

      sql   = 'SELECT * FROM rides WHERE id = ?';
      param = id;
    } else {
      return res.status(400).json({ success: false, error: 'Phone or ID required' });
    }

    const [rows] = await pool.query(sql, [param]);

    if (id && rows.length > 0) {
      bookingCache.set(`booking_${id}`, rows[0]);
    }

    res.json({ bookings: rows });
  } catch (err) {
    logger.error({ event: 'fetch_booking_error', message: err.message });
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ── PATCH /api/bookings/:id/cancel ────────────────────────────────────────────
// Rider-initiated cancellation.
//   • Sets status = 'cancelled' in DB (record is preserved for history)
//   • Only allowed when status is 'pending' or 'open_market';
//     returns 409 if the ride is already accepted (call support instead)
//   • Invalidates both caches
//   • Pushes real-time events so the rider's live-dot + the vendor console
//     both update without a page refresh
router.patch('/:id/cancel', async (req, res) => {
  const { id } = req.params;
  try {
    const [result] = await pool.query(
      "UPDATE rides SET status = 'cancelled' WHERE id = ? AND status IN ('pending', 'open_market')",
      [id]
    );

    if (result.affectedRows === 0) {
      logger.warn({ event: 'cancel_conflict', rideId: id });
      return res.status(409).json({
        success: false,
        error: 'Ride cannot be cancelled in its current state.'
      });
    }

    // Invalidate both caches
    statusCache.del(`status_${id}`);
    bookingCache.del(`booking_${id}`);

    // Push real-time events (non-fatal if socket not yet ready)
    try {
      const io = socketModule.getIO();
      // Rider's confirmation page / dashboard: update live status indicator
      io.to(`booking_${id}`).emit('status_update', { bookingId: id, status: 'cancelled' });
      // Vendor console: remove card from Incoming column
      io.to('vendor_room').emit('ride_actioned', { id, status: 'cancelled' });
    } catch (socketErr) {
      logger.warn({ event: 'cancel_socket_fail', message: socketErr.message });
    }

    logger.info({ event: 'booking_cancelled', rideId: id });
    res.json({ success: true, status: 'cancelled' });
  } catch (err) {
    logger.error({ event: 'cancel_error', message: err.message, rideId: id });
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ── DELETE /api/bookings/:id ──────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM rides WHERE id = ?', [id]);
    statusCache.del(`status_${id}`);
    bookingCache.del(`booking_${id}`);
    logger.info({ event: 'booking_deleted', rideId: id });
    res.json({ success: true });
  } catch (err) {
    logger.error({ event: 'delete_error', message: err.message, rideId: id });
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

module.exports = router;
