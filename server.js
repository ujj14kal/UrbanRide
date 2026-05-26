// server.js — UrbanRide Express + Socket.io server
//
// FAANG patterns present in this file:
//   Correlation IDs    — every request gets X-Request-ID (uuid); logged on every
//                        line so you can grep a single request through all logs
//   Structured logging — Winston JSON; all console.log replaced so log aggregators
//                        (Datadog / ELK / CloudWatch) can parse and alert on fields
//   Rate limiting      — two tiers: general API + booking creation
//   Security headers   — helmet (CSP disabled for external Maps / Firebase scripts)
//   Input validation   — express-validator in booking.js (422 structured errors)
//   Health endpoint    — /health returns uptime + 3-tier cache stats
//   Graceful shutdown  — SIGTERM → server.close() so Kubernetes drains cleanly

const http       = require('http');
const express    = require('express');
const cors       = require('cors');
const dotenv     = require('dotenv');
const bodyParser = require('body-parser');
const path       = require('path');
const axios      = require('axios');
const helmet     = require('helmet');
const morgan     = require('morgan');
const rateLimit  = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');

dotenv.config();

// ── Internal modules ──────────────────────────────────────────────────────────
const logger        = require('./logger');
const db            = require('./db');
const bookingRoutes = require('./booking');
const invoiceRouter = require('./invoiceRouter');
const socketModule  = require('./socket');
const { statusCache, bookingCache, getStats } = require('./cache');
const { sendRideCompleteEmail } = require('./mailer');

// ── App + HTTP server ─────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = socketModule.init(server);

// ── Security headers ──────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));

// ── Correlation ID — attach to every request ──────────────────────────────────
// Clients may pass their own X-Request-ID (useful for end-to-end tracing from
// the browser); otherwise we generate one.  The ID is echoed back in the response
// header so clients can correlate their logs with server logs.
app.use((req, res, next) => {
  req.id = req.headers['x-request-id'] || uuidv4();
  res.setHeader('X-Request-ID', req.id);
  next();
});

// ── Structured HTTP access log ────────────────────────────────────────────────
// morgan pipes into Winston so every access line is a JSON object, not a string.
// This means log aggregators can filter by status code, latency, or route directly.
app.use(morgan(
  (tokens, req, res) => JSON.stringify({
    event:      'http_request',
    method:     tokens.method(req, res),
    url:        tokens.url(req, res),
    status:     parseInt(tokens.status(req, res), 10),
    latency_ms: parseFloat(tokens['response-time'](req, res)),
    req_id:     req.id
  }),
  { stream: { write: line => logger.info(JSON.parse(line.trim())) } }
));

// ── Rate limiting ─────────────────────────────────────────────────────────────
// General: 100 req / 15 min per IP
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      100,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many requests, please try again later.' }
});

// Booking creation: 10 req / min per IP (prevent spam)
const bookingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      10,
  message:  { error: 'Too many booking attempts, please slow down.' }
});

// ── Vendor auth ───────────────────────────────────────────────────────────────
const VENDOR_TOKEN = process.env.VENDOR_PASSWORD || 'urbanride_vendor';

function vendorAuth(req, res, next) {
  const token =
    req.headers['x-vendor-token'] ||
    req.body?.token ||
    req.query.token;

  if (token !== VENDOR_TOKEN) {
    logger.warn({ event: 'vendor_auth_fail', ip: req.ip, reqId: req.id });
    return res.status(401).json({ error: 'Unauthorized — invalid vendor token' });
  }
  next();
}

// ── Core middleware ───────────────────────────────────────────────────────────
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/', apiLimiter);

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:    'healthy',
    uptime:    process.uptime(),
    timestamp: new Date().toISOString(),
    cache:     getStats(),
    version:   '2.0.0'
  });
});

// ── Static pages ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/html', 'index.html'));
});

// ── Invoice routes ────────────────────────────────────────────────────────────
app.use('/invoice', invoiceRouter);

// ── Booking status (cache-first) ──────────────────────────────────────────────
app.get('/booking-status/:id', async (req, res) => {
  const { id } = req.params;

  const cached = statusCache.get(`status_${id}`);
  if (cached !== undefined) {
    return res.json({ status: cached, source: 'cache' });
  }

  try {
    const [rows] = await db.query('SELECT status FROM rides WHERE id = ?', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Booking not found' });

    statusCache.set(`status_${id}`, rows[0].status);
    res.json({ status: rows[0].status, source: 'db' });
  } catch (err) {
    logger.error({ event: 'status_fetch_error', message: err.message, reqId: req.id });
    res.status(500).json({ error: 'Failed to fetch booking status' });
  }
});

// ── Directions proxy ──────────────────────────────────────────────────────────
app.post('/directions', async (req, res) => {
  const { origin, destination } = req.body;
  if (!origin || !destination) {
    return res.status(400).json({ error: 'Origin and destination are required.' });
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&key=${apiKey}&traffic_model=best_guess&departure_time=now`;

  try {
    const response = await axios.get(url);
    const data     = response.data;

    if (!data.routes || data.routes.length === 0) {
      return res.status(404).json({ error: 'No route found.' });
    }

    const leg = data.routes[0].legs[0];
    return res.json({
      distance:            leg.distance.text,
      duration:            leg.duration.text,
      duration_in_traffic: leg.duration_in_traffic?.text ?? leg.duration.text
    });
  } catch (err) {
    logger.error({ event: 'directions_error', message: err.message, reqId: req.id });
    return res.status(500).json({ error: 'Failed to fetch directions.' });
  }
});

// ── Vendor Console API ────────────────────────────────────────────────────────

// GET /api/vendor/rides
// Returns three buckets:
//   active  — the one ride currently in progress (status = accepted)
//   pending — rides awaiting a decision
//   recent  — rejected / completed / cancelled (last 30)
app.get('/api/vendor/rides', vendorAuth, async (req, res) => {
  try {
    const [active] = await db.query(
      "SELECT * FROM rides WHERE status = 'accepted' ORDER BY id DESC LIMIT 1"
    );
    const [pending] = await db.query(
      "SELECT * FROM rides WHERE status IN ('pending','open_market') ORDER BY id DESC"
    );
    const [recent] = await db.query(
      "SELECT * FROM rides WHERE status IN ('rejected','completed','cancelled') ORDER BY id DESC LIMIT 30"
    );
    res.json({ active, pending, recent });
  } catch (err) {
    logger.error({ event: 'vendor_rides_error', message: err.message });
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/vendor/respond/:id — accept / reject / open_market
// Accepting is blocked when a ride is already in progress (status = accepted).
app.post('/api/vendor/respond/:id', vendorAuth, async (req, res) => {
  const { action } = req.body;
  const { id }     = req.params;

  const statusMap = { accept: 'accepted', reject: 'rejected', open_market: 'open_market' };
  const newStatus = statusMap[action];
  if (!newStatus) return res.status(400).json({ error: 'Invalid action' });

  // One-active-ride enforcement — only for accept
  if (newStatus === 'accepted') {
    const [active] = await db.query(
      "SELECT id FROM rides WHERE status = 'accepted' LIMIT 1"
    );
    if (active.length > 0) {
      return res.status(409).json({
        error: `Cannot accept — Ride #${active[0].id} is still in progress. End it first.`
      });
    }
  }

  try {
    await db.query('UPDATE rides SET status = ? WHERE id = ?', [newStatus, id]);
    statusCache.del(`status_${id}`);
    bookingCache.del(`booking_${id}`);

    // Fetch full ride data so vendor_room gets it for the active-ride banner
    const [rows] = await db.query('SELECT * FROM rides WHERE id = ?', [id]);
    const ride   = rows[0] || null;

    io.to(`booking_${id}`).emit('status_update', { bookingId: id, status: newStatus });
    io.to('vendor_room').emit('ride_actioned',   { id, status: newStatus, ride });

    logger.info({ event: 'vendor_respond', rideId: id, status: newStatus });
    res.json({ success: true, status: newStatus });
  } catch (err) {
    logger.error({ event: 'vendor_respond_error', message: err.message });
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/vendor/end-ride/:id — driver marks ride as completed
//   • Sets status = 'completed'
//   • Sends invoice email to rider (non-blocking)
//   • Pushes real-time events to rider + vendor console
app.post('/api/vendor/end-ride/:id', vendorAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const [rows] = await db.query(
      "SELECT * FROM rides WHERE id = ? AND status = 'accepted'", [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'No active ride found with that ID.' });
    }
    const ride = rows[0];

    await db.query("UPDATE rides SET status = 'completed' WHERE id = ?", [id]);
    statusCache.del(`status_${id}`);
    bookingCache.del(`booking_${id}`);

    // Rider dashboard: show completed status live
    io.to(`booking_${id}`).emit('status_update', { bookingId: id, status: 'completed' });
    // Vendor console: clear active-ride banner
    io.to('vendor_room').emit('ride_ended', { id, status: 'completed' });

    // Email invoice — fire-and-forget, never blocks the HTTP response
    sendRideCompleteEmail(ride).catch(err =>
      logger.error({ event: 'invoice_email_error', rideId: id, message: err.message })
    );

    logger.info({ event: 'ride_ended', rideId: id, email: ride.email });
    res.json({ success: true, status: 'completed' });
  } catch (err) {
    logger.error({ event: 'end_ride_error', message: err.message });
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Booking CRUD ──────────────────────────────────────────────────────────────
app.use('/api/bookings', bookingLimiter, bookingRoutes);

// ── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  logger.info({ event: 'socket_connected', socketId: socket.id });

  socket.on('join_booking', (bookingId) => {
    socket.join(`booking_${bookingId}`);
    logger.info({ event: 'socket_join_booking', socketId: socket.id, bookingId });
  });

  socket.on('join_vendor', (token) => {
    if (token === VENDOR_TOKEN) {
      socket.join('vendor_room');
      socket.emit('vendor_auth', { ok: true });
      logger.info({ event: 'vendor_socket_auth', socketId: socket.id });
    } else {
      socket.emit('vendor_auth', { ok: false });
      logger.warn({ event: 'vendor_socket_auth_fail', socketId: socket.id });
    }
  });

  socket.on('disconnect', () => {
    logger.info({ event: 'socket_disconnected', socketId: socket.id });
  });
});

// ── Global error handler ──────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error({ event: 'unhandled_error', message: err.message, stack: err.stack, reqId: req.id });
  res.status(500).json({ error: 'Internal server error' });
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
// Kubernetes sends SIGTERM before killing the pod; we finish in-flight requests
// before closing so no requests are dropped mid-flight.
process.on('SIGTERM', () => {
  logger.info({ event: 'sigterm_received' });
  server.close(() => {
    logger.info({ event: 'server_closed' });
    process.exit(0);
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  logger.info({ event: 'server_started', port: PORT });
  require('./vc');
  logger.info({ event: 'vc_loaded' });
});
