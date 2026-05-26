// cache.js — In-memory caching layer using node-cache
//
// Three tiers, each tuned to its access pattern:
//   statusCache      — short TTL, mutates often (pending → accepted/rejected)
//   bookingCache     — medium TTL, full rows are expensive to recompute
//   idempotencyCache — long TTL, guards POST /api/bookings against duplicate inserts
//
// At 10 M users this file becomes:
//   const Redis = require('ioredis');
//   module.exports = { statusCache: new Redis(...), ... }
// The rest of the codebase uses the same .get/.set/.del API — no other changes needed.

const NodeCache = require('node-cache');

// ── Status cache (30 s TTL) ───────────────────────────────────────────────────
// Stale reads are harmless — real-time push via Socket.io handles instant updates.
const statusCache = new NodeCache({
  stdTTL:      30,
  checkperiod: 60,
  useClones:   false  // avoid deep-clone overhead for plain strings
});

// ── Booking details cache (2 min TTL) ────────────────────────────────────────
// Full booking rows rarely change after creation.
const bookingCache = new NodeCache({
  stdTTL:      120,
  checkperiod: 240,
  useClones:   false
});

// ── Idempotency cache (24 hr TTL) ────────────────────────────────────────────
// Key: `idem_<X-Idempotency-Key header>`  Value: the response JSON that was sent.
// If a client retries a POST /api/bookings with the same key within 24 hours,
// we return the cached response without touching the DB or RabbitMQ.
const idempotencyCache = new NodeCache({
  stdTTL:      86400,   // 24 hours
  checkperiod: 3600,    // sweep every hour
  useClones:   false
});

// ── Stats helper (exposed via /health) ───────────────────────────────────────
function getStats() {
  return {
    status:      statusCache.getStats(),
    booking:     bookingCache.getStats(),
    idempotency: idempotencyCache.getStats()
  };
}

module.exports = { statusCache, bookingCache, idempotencyCache, getStats };
