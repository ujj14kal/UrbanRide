// server.js — UrbanRide Express + Socket.io server

const http         = require('http');
const express      = require('express');
const cors         = require('cors');
const dotenv       = require('dotenv');
const bodyParser   = require('body-parser');
const path         = require('path');
const axios        = require('axios');
const helmet       = require('helmet');
const morgan       = require('morgan');
const rateLimit    = require('express-rate-limit');

dotenv.config();

// ── Internal modules ─────────────────────────────────────────────────────────
const db            = require('./db');
const bookingRoutes = require('./booking');
const invoiceRouter = require('./invoiceRouter');
const socketModule  = require('./socket');
const { statusCache, bookingCache, getStats } = require('./cache');

// ── App + HTTP server ─────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = socketModule.init(server);   // must happen before vc.js is loaded

// ── Security ──────────────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false  // external Maps / Firebase scripts in HTML
}));

// ── Logging ───────────────────────────────────────────────────────────────────
app.use(morgan('combined'));

// ── Rate limiting ─────────────────────────────────────────────────────────────
// General API — 100 req / 15 min per IP
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});

// Booking creation — 10 req / min per IP (prevent spam)
const bookingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many booking attempts, please slow down.' }
});

// ── Core middleware ────────────────────────────────────────────────────────────
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/', apiLimiter);

// ── Health check ──────────────────────────────────────────────────────────────
// Used by load balancers / uptime monitors. Returns 200 when healthy.
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
// Client polls this as a fallback; primary updates come via Socket.io.
app.get('/booking-status/:id', async (req, res) => {
  const bookingId = req.params.id;

  const cached = statusCache.get(`status_${bookingId}`);
  if (cached !== undefined) {
    return res.json({ status: cached, source: 'cache' });
  }

  try {
    const [rows] = await db.query('SELECT status FROM rides WHERE id = ?', [bookingId]);
    if (rows.length === 0) return res.status(404).json({ error: 'Booking not found' });

    statusCache.set(`status_${bookingId}`, rows[0].status);
    res.json({ status: rows[0].status, source: 'db' });
  } catch (err) {
    console.error('Error fetching booking status:', err.message);
    res.status(500).json({ error: 'Failed to fetch booking status' });
  }
});

// ── Directions proxy ──────────────────────────────────────────────────────────
// Proxies the Google Maps Directions API so the key stays server-side.
app.post('/directions', async (req, res) => {
  const { origin, destination } = req.body;
  if (!origin || !destination) {
    return res.status(400).json({ error: 'Origin and destination are required.' });
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&key=${apiKey}&traffic_model=best_guess&departure_time=now`;

  try {
    const response = await axios.get(url);
    const data = response.data;

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
    console.error('Directions API error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch directions.' });
  }
});

// ── Booking CRUD ──────────────────────────────────────────────────────────────
app.use('/api/bookings', bookingLimiter, bookingRoutes);

// ── Telegram webhook ──────────────────────────────────────────────────────────
// Alternative to the Telegram bot callback_query handler in vc.js.
// Handles slash-command style messages: /accept_42, /reject_42
app.post('/telegram-update', async (req, res) => {
  const message = req.body?.message;
  if (!message?.text) return res.sendStatus(200);

  const chatId = message.chat.id;
  const match  = message.text.trim().match(/^\/(accept|reject|openmarket)_(\d+)$/);
  if (!match) return res.sendStatus(200);

  const [, action, bookingId] = match;
  const newStatus =
    action === 'accept'     ? 'accepted'    :
    action === 'reject'     ? 'rejected'    :
    action === 'openmarket' ? 'open_market' : null;

  if (!newStatus) return res.sendStatus(400);

  try {
    await db.query('UPDATE rides SET status = ? WHERE id = ?', [newStatus, bookingId]);

    // Invalidate cache so next HTTP poll gets fresh data
    statusCache.del(`status_${bookingId}`);
    bookingCache.del(`booking_${bookingId}`);

    // Push real-time update to any clients watching this booking
    io.to(`booking_${bookingId}`).emit('status_update', {
      bookingId,
      status: newStatus
    });

    await axios.post(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id:    chatId,
        text:       `✅ Booking ${bookingId} marked as *${newStatus}*`,
        parse_mode: 'Markdown'
      }
    );

    return res.sendStatus(200);
  } catch (err) {
    console.error('Telegram webhook error:', err.message);
    return res.sendStatus(500);
  }
});

// ── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`🔌 Socket connected: ${socket.id}`);

  // Client joins a room keyed to their booking ID so we can target pushes
  socket.on('join_booking', (bookingId) => {
    socket.join(`booking_${bookingId}`);
    console.log(`📌 ${socket.id} watching booking ${bookingId}`);
  });

  socket.on('disconnect', () => {
    console.log(`🔌 Socket disconnected: ${socket.id}`);
  });
});

// ── Global error handler ──────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully…');
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚖  UrbanRide backend live on port ${PORT}`);

  // Load vc.js AFTER socket.io is ready so getIO() succeeds
  require('./vc');
  console.log('✅  vc.js (RabbitMQ + Telegram consumer) started');
});
