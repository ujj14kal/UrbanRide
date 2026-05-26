// mailer.js — Invoice email sent to rider when driver ends the ride
//
// Uses nodemailer with Gmail SMTP (free).
// Required env vars on Render:
//   EMAIL_USER  — your Gmail address, e.g. noreply@yourdomain.com
//   EMAIL_PASS  — Gmail App Password (not your real password)
//                 Generate at: myaccount.google.com → Security → App passwords
//
// If neither var is set the function logs a warning and returns silently —
// the ride still ends, email is just skipped (safe for local dev without creds).

const nodemailer          = require('nodemailer');
const PDFDocument         = require('pdfkit');
const path                = require('path');
const logger              = require('./logger');

// ── Lazy transporter — only built when creds are present ─────────────────────
function makeTransporter() {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) return null;
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
  });
}

// ── Build invoice PDF as a Buffer (to attach to email) ───────────────────────
function buildInvoiceBuffer(booking) {
  return new Promise((resolve, reject) => {
    const doc    = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data',  c => chunks.push(c));
    doc.on('end',   () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Try logo — skip gracefully if missing
    const logoPath = path.join(__dirname, 'public', 'images', 'logo.png');
    try { doc.image(logoPath, 50, 40, { width: 100 }); } catch (_) {}

    doc.moveDown(2.5);
    doc.font('Helvetica-Bold').fontSize(22).fillColor('#000').text('UrbanRide Invoice', 170, 50);
    doc.moveDown(1.5);
    doc.lineWidth(1).strokeColor('#ccc').moveTo(50, doc.y).lineTo(550, doc.y).stroke();
    doc.moveDown(1.5);
    doc.font('Helvetica').fontSize(13).fillColor('#333');
    doc.text(`Booking ID:         ${booking.id}`);
    doc.text(`Guest Name:         ${booking.guest_name}`);
    doc.text(`Phone:              ${booking.phone}`);
    doc.text(`Pickup:             ${booking.pickup}`);
    doc.text(`Drop-off:           ${booking.dropoff}`);
    doc.text(`Vehicle:            ${booking.vehicle_type}  ·  ${booking.passengers || 1} passenger(s)`);
    if (booking.associated_member) doc.text(`Driver:             ${booking.associated_member}`);
    doc.moveDown(2);
    doc.fontSize(10).fillColor('#888').text('Thank you for choosing UrbanRide!', { align: 'center' });
    doc.end();
  });
}

// ── HTML email body ───────────────────────────────────────────────────────────
function buildHtml(booking) {
  const dt = booking.date_time
    ? new Date(booking.date_time).toLocaleString('en-IN', { dateStyle: 'long', timeStyle: 'short' })
    : '—';

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8">
<style>
  body{font-family:-apple-system,Arial,sans-serif;background:#f5f5f5;margin:0;padding:24px}
  .card{background:#fff;border-radius:12px;max-width:520px;margin:0 auto;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.08)}
  .hdr{background:#000;color:#fff;padding:28px 32px}
  .hdr h1{margin:0;font-size:20px;letter-spacing:-.4px}
  .hdr p{margin:6px 0 0;font-size:13px;color:#aaa}
  .body{padding:24px 32px}
  .row{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #f0f0f0;font-size:14px}
  .row:last-of-type{border:none}
  .lbl{color:#777}
  .val{font-weight:600;color:#111;text-align:right}
  .cta{display:block;margin:20px 0 0;background:#000;color:#fff;text-decoration:none;padding:13px 20px;border-radius:8px;text-align:center;font-weight:700;font-size:14px}
  .foot{padding:16px 32px;font-size:11px;color:#bbb;border-top:1px solid #f0f0f0}
</style></head>
<body>
<div class="card">
  <div class="hdr">
    <h1>UrbanRide — Ride Complete ✓</h1>
    <p>Booking #${booking.id} · Invoice attached</p>
  </div>
  <div class="body">
    <div class="row"><span class="lbl">Guest</span><span class="val">${booking.guest_name}</span></div>
    <div class="row"><span class="lbl">Phone</span><span class="val">${booking.phone}</span></div>
    <div class="row"><span class="lbl">Pickup</span><span class="val">${booking.pickup}</span></div>
    <div class="row"><span class="lbl">Drop-off</span><span class="val">${booking.dropoff}</span></div>
    <div class="row"><span class="lbl">Vehicle</span><span class="val">${booking.vehicle_type} · ${booking.passengers || 1} pax</span></div>
    <div class="row"><span class="lbl">Date</span><span class="val">${dt}</span></div>
    ${booking.associated_member ? `<div class="row"><span class="lbl">Driver</span><span class="val">${booking.associated_member}</span></div>` : ''}
  </div>
  <div class="foot">UrbanRide Technologies · This is an automated receipt</div>
</div>
</body></html>`;
}

// ── Main export ───────────────────────────────────────────────────────────────
async function sendRideCompleteEmail(booking) {
  if (!booking.email) {
    logger.info({ event: 'email_skipped', reason: 'no email on booking', rideId: booking.id });
    return;
  }

  const transporter = makeTransporter();
  if (!transporter) {
    logger.warn({ event: 'email_skipped', reason: 'EMAIL_USER/EMAIL_PASS not set', rideId: booking.id });
    return;
  }

  const pdfBuffer = await buildInvoiceBuffer(booking);

  await transporter.sendMail({
    from:    `"UrbanRide" <${process.env.EMAIL_USER}>`,
    to:      booking.email,
    subject: `Your UrbanRide receipt — Booking #${booking.id}`,
    html:    buildHtml(booking),
    attachments: [{
      filename:    `UrbanRide_Invoice_${booking.id}.pdf`,
      content:     pdfBuffer,
      contentType: 'application/pdf'
    }]
  });

  logger.info({ event: 'invoice_email_sent', rideId: booking.id, to: booking.email });
}

module.exports = { sendRideCompleteEmail };
