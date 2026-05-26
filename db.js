// db.js — MySQL connection pool (mysql2/promise)
//
// Why a pool over a single connection:
//   A single connection serialises every query.  Under concurrent requests
//   (booking + status + vendor dashboard hitting the DB at the same time)
//   a pool lets MySQL serve them in parallel up to connectionLimit.
//
// Why indexes matter:
//   Without them, SELECT … WHERE phone = ? is a full table scan — O(n) at 10 M rows.
//   We create the three most-needed indexes on every startup (error code 1061 = already
//   exists; we swallow that silently so restarts are always safe).

require('dotenv').config();
const mysql  = require('mysql2/promise');
const logger = require('./logger');

const pool = mysql.createPool({
  host:               process.env.MYSQLHOST,
  user:               process.env.MYSQLUSER,
  password:           process.env.MYSQLPASSWORD,
  database:           process.env.MYSQLDATABASE,
  port:               parseInt(process.env.MYSQLPORT || '3306', 10),
  ssl:                { rejectUnauthorized: false },
  waitForConnections: true,
  connectionLimit:    10,   // 10 concurrent DB connections per Node process
  queueLimit:         0     // no limit on waiting requests
});

// ── Index bootstrap ───────────────────────────────────────────────────────────
// Run once at startup.  ER_DUP_KEYNAME (1061) means the index already exists — safe to ignore.
async function ensureIndexes() {
  const indexes = [
    // Rider dashboard: fetch all rides by phone number
    ['idx_rides_phone',     'CREATE INDEX idx_rides_phone     ON rides (phone)'],
    // Vendor console: fetch pending/recent rides filtered by status
    ['idx_rides_status',    'CREATE INDEX idx_rides_status    ON rides (status)'],
    // Compound: vendor query ORDER BY id DESC with status filter
    ['idx_rides_status_id', 'CREATE INDEX idx_rides_status_id ON rides (status, id)'],
  ];

  const conn = await pool.getConnection();
  try {
    for (const [name, sql] of indexes) {
      try {
        await conn.query(sql);
        logger.info({ event: 'db_index_created', index: name });
      } catch (err) {
        if (err.code === 'ER_DUP_KEYNAME') {
          // Index already exists — expected on every restart after the first
        } else {
          logger.warn({ event: 'db_index_warn', index: name, code: err.code, msg: err.message });
        }
      }
    }
    logger.info({ event: 'db_indexes_ok' });
  } finally {
    conn.release();
  }
}

// Verify connectivity and create indexes on first import
pool.getConnection()
  .then(conn => {
    logger.info({ event: 'db_connected', host: process.env.MYSQLHOST });
    conn.release();
    return ensureIndexes();
  })
  .catch(err => {
    logger.error({ event: 'db_connect_failed', message: err.message });
    process.exit(1);
  });

module.exports = pool;
