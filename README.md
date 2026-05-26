# 🚖 UrbanRide — Corporate Cab Booking Platform

A full-stack, production-grade cab booking platform built for corporate clients.
Real-time vendor notifications via Telegram, WebSocket-powered live status updates,
in-memory caching, rate limiting, and PDF invoice generation.

**Live:** [https://urbanride.onrender.com](https://urbanride.onrender.com)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         CLIENT (Browser)                        │
│  index.html  booking.html  confirmation.html  account.html      │
│                     Socket.io client                            │
└─────────────────────┬──────────────────┬───────────────────────┘
                      │ HTTP/REST        │ WebSocket (Socket.io)
                      ▼                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Express Server  (server.js)                  │
│                                                                 │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────────┐  │
│  │  helmet     │  │ morgan       │  │ express-rate-limit    │  │
│  │ (security)  │  │ (logging)    │  │ (100 req/15min)       │  │
│  └─────────────┘  └──────────────┘  └───────────────────────┘  │
│                                                                 │
│  GET  /health          → uptime + cache stats                   │
│  POST /api/bookings    → create booking (validated)             │
│  GET  /api/bookings    → fetch by phone or ID (cached)          │
│  POST /directions      → Google Maps proxy (key server-side)    │
│  GET  /invoice/:id     → stream PDF                             │
│  POST /telegram-update → webhook fallback                       │
│                                                                 │
│  ┌────────────────────────────────────────────────────────┐     │
│  │            node-cache  (in-memory cache)               │     │
│  │   statusCache  TTL=30s  |  bookingCache  TTL=120s      │     │
│  │   (prod upgrade path: swap for Redis — same API)       │     │
│  └────────────────────────────────────────────────────────┘     │
└─────────────────────────────┬───────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
      ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
      │  Aiven MySQL │ │  CloudAMQP   │ │  Socket.io   │
      │  (rides tbl) │ │  RabbitMQ    │ │  rooms       │
      └──────────────┘ └──────┬───────┘ └──────────────┘
                              │ ride_requests queue
                              ▼
              ┌─────────────────────────────────┐
              │     vc.js  (Vendor Consumer)     │
              │                                 │
              │  Consumes queue → Telegram bot  │
              │  Vendor taps Accept/Reject       │
              │     ↓                           │
              │  UPDATE rides SET status=...    │
              │  Cache invalidation             │
              │  io.emit('status_update', ...)  │
              └─────────────────────────────────┘
                              │
                              ▼
              ┌─────────────────────────────────┐
              │         Telegram Bot            │
              │  Inline keyboard: ✅ ❌ 📤       │
              └─────────────────────────────────┘
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 18+ |
| Framework | Express 4 |
| Real-time | **Socket.io** (WebSocket) |
| Caching | **node-cache** (Redis-compatible API) |
| Message Queue | **RabbitMQ** via CloudAMQP |
| Database | **MySQL** via Aiven (SSL) |
| Auth | Firebase Phone OTP |
| Maps | Google Maps API (Directions + Places) |
| Vendor Alerts | Telegram Bot API |
| PDF | PDFKit |
| Security | helmet · express-rate-limit · express-validator |
| Logging | morgan |
| Hosting | Render |

---

## Key Engineering Decisions

### WebSocket over Polling
The original confirmation page polled `/booking-status/:id` every 3 seconds.
Replaced with **Socket.io rooms** — each user joins `booking_<id>` on page load.
When the vendor taps Accept/Reject on Telegram, `vc.js` emits directly to that room.
Result: **zero polling, instant push, lower server load at scale**.

### Caching Layer
`/api/bookings?id=X` is called repeatedly (booking info + status polling fallback).
Added an **in-memory cache** with two tiers:
- `statusCache` — 30s TTL (status changes, short-lived)
- `bookingCache` — 120s TTL (booking details, rarely change)

Cache is invalidated on every status update. At 10M users this becomes Redis
(shared across instances) — the module API is intentionally identical.

### Message Queue (RabbitMQ)
Booking creation is **decoupled** from vendor notification:
1. POST `/api/bookings` → INSERT → ACK to client in ~50ms
2. Message queued to `ride_requests`
3. `vc.js` consumer picks it up, sends Telegram message

This means a Telegram outage does not affect booking success rate.
Messages are `persistent: true` so they survive broker restarts.

### Input Validation
All booking fields validated with **express-validator** before touching the DB:
- Phone format, email normalisation, vehicle type enum, date ISO8601 check.
- Returns structured `422` errors (field + message) rather than a 500 crash.

---

## API Reference

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Uptime + cache stats (load balancer probe) |
| `POST` | `/api/bookings` | Create booking (validated, queued) |
| `GET` | `/api/bookings?id=` | Get booking by ID (cached) |
| `GET` | `/api/bookings/by-phone/:phone` | All bookings for a phone number |
| `DELETE` | `/api/bookings/:id` | Cancel booking (cache-busted) |
| `GET` | `/booking-status/:id` | Status only — cache-first |
| `POST` | `/directions` | Google Maps proxy (key stays server-side) |
| `GET` | `/invoice/:id` | Stream PDF invoice |

---

## Running Locally

```bash
# 1. Install dependencies
npm install

# 2. Fill in environment variables
cp .env .env.local   # edit with your credentials

# 3. Start the server (port 5000)
npm start
```

### Required environment variables

```
MYSQLHOST=
MYSQLUSER=
MYSQLPASSWORD=
MYSQLDATABASE=
MYSQLPORT=

RABBITMQ_URL=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
GOOGLE_MAPS_API_KEY=
PORT=5000
```

---

## Pages

| Page | Path | Description |
|---|---|---|
| Landing | `/` | Hero, animated stats, features, testimonials |
| Booking | `/html/booking.html` | Multi-field form with Maps autocomplete + route preview |
| Confirmation | `/html/confirmation.html` | Dark map, live status badge (WebSocket), invoice download |
| Account | `/html/account.html` | Firebase OTP login → booking history cards |

---

## Booking Flow

```
User submits form
      │
      ▼
POST /api/bookings  ──► Validate inputs (express-validator)
      │                        │
      │ 422 on error ◄─────────┘
      │
      ▼
INSERT INTO rides (status='pending')
      │
      ├──► Warm statusCache immediately
      │
      ▼
channel.sendToQueue('ride_requests', { persistent: true })
      │
      ▼
Redirect → /html/confirmation.html?booking_id=42
      │
      ├── Socket.io: client joins room 'booking_42'
      └── Map rendered, status badge shows 'Pending'

      [async — vc.js consumer]
            │
            ▼
      Telegram message sent to vendor
            │
      Vendor taps [✅ Accept]
            │
            ▼
      UPDATE rides SET status='accepted'
      statusCache.del('status_42')
      io.to('booking_42').emit('status_update', { status:'accepted' })
            │
            ▼
      Browser: badge → 'Accepted' (green), accept.mp3 plays, invoice link appears
```

---

## License

MIT © 2025 Ujjwal Kalra
