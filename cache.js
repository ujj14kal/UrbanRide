// cache.js — In-memory caching layer using node-cache
//
// In production at scale this would be replaced with Redis (shared across
// multiple Node.js instances). node-cache gives the same API with zero
// infrastructure cost — swap by changing only this file.

const NodeCache = require('node-cache');

// ── Status cache ─────────────────────────────────────────────────────────────
// Short TTL: booking status changes frequently (pending → accepted/rejected).
// Stale reads are harmless; real-time push via Socket.io handles instant updates.
const statusCache = new NodeCache({
  stdTTL: 30,       // 30-second TTL
  checkperiod: 60,  // Sweep for expired keys every 60 s
  useClones: false  // Avoid deep-clone overhead for plain strings
});

// ── Booking details cache ─────────────────────────────────────────────────────
// Longer TTL: full booking rows rarely change after creation.
const bookingCache = new NodeCache({
  stdTTL: 120,      // 2-minute TTL
  checkperiod: 240,
  useClones: false
});

// ── Cache stats helper (useful for health/metrics endpoints) ──────────────────
function getStats() {
  return {
    status: statusCache.getStats(),
    booking: bookingCache.getStats()
  };
}

module.exports = { statusCache, bookingCache, getStats };
