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

const nodemailer  = require('nodemailer');
const PDFDocument = require('pdfkit');
const path        = require('path');
const logger      = require('./logger');

// ── Lazy transporter ──────────────────────────────────────────────────────────
function makeTransporter() {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) return null;
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtDate(raw) {
  if (!raw) return '—';
  return new Date(raw).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'long', year: 'numeric'
  });
}

function fmtTime(raw) {
  if (!raw) return '';
  return new Date(raw).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', hour12: true
  });
}

function bookingRef(id) {
  return `#UR-${String(id).padStart(6, '0')}`;
}

// ── PDF invoice ───────────────────────────────────────────────────────────────
// A4 = 595.28 × 841.89 pt  |  margins: 44 left/right
function buildInvoiceBuffer(booking) {
  return new Promise((resolve, reject) => {
    const doc    = new PDFDocument({ size: 'A4', margin: 0, info: {
      Title:   `UrbanRide Invoice ${bookingRef(booking.id)}`,
      Author:  'UrbanRide',
      Subject: 'Ride Receipt'
    }});
    const chunks = [];
    doc.on('data',  c => chunks.push(c));
    doc.on('end',   () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W  = 595.28;          // page width
    const ML = 44;              // left margin
    const MR = W - 44;         // right margin
    const CW = MR - ML;        // content width  (507.28)

    // ── Palette ──
    const BLACK   = '#0a0a0a';
    const WHITE   = '#ffffff';
    const GREEN   = '#16a34a';
    const GREEN_L = '#dcfce7';
    const GRAY_50 = '#f9fafb';
    const GRAY_100= '#f3f4f6';
    const GRAY_200= '#e5e7eb';
    const GRAY_400= '#9ca3af';
    const GRAY_600= '#4b5563';
    const GRAY_800= '#1f2937';

    // ═══════════════════════════════════════════════════════════════════════════
    // 1 ── HEADER BAND  (full-width black, height 100)
    // ═══════════════════════════════════════════════════════════════════════════
    doc.rect(0, 0, W, 100).fill(BLACK);

    // Logo — try, skip if missing
    try {
      doc.image(path.join(__dirname, 'public', 'images', 'logo.png'),
        ML, 24, { height: 52 });
    } catch (_) {}

    // Brand name
    doc.font('Helvetica-Bold').fontSize(20).fillColor(WHITE)
       .text('UrbanRide', ML + 62, 32, { lineBreak: false });
    doc.font('Helvetica').fontSize(9).fillColor(GRAY_400)
       .text('Premium Cab Service', ML + 63, 57, { lineBreak: false });

    // "INVOICE" label — top right
    doc.font('Helvetica-Bold').fontSize(26).fillColor(WHITE)
       .text('INVOICE', 0, 28, { align: 'right', width: MR, lineBreak: false });

    // Booking ref below it
    doc.font('Helvetica').fontSize(10).fillColor(GRAY_400)
       .text(bookingRef(booking.id), 0, 60, { align: 'right', width: MR, lineBreak: false });

    // ═══════════════════════════════════════════════════════════════════════════
    // 2 ── GREEN ACCENT STRIPE  (4 px)
    // ═══════════════════════════════════════════════════════════════════════════
    doc.rect(0, 100, W, 4).fill(GREEN);

    // ═══════════════════════════════════════════════════════════════════════════
    // 3 ── META BAR  (date / vehicle / status chips)
    // ═══════════════════════════════════════════════════════════════════════════
    doc.rect(0, 104, W, 48).fill(GRAY_50);
    doc.rect(0, 152, W, 1).fillColor(GRAY_200).fill(GRAY_200);

    const chips = [
      { label: 'DATE',    value: fmtDate(booking.date_time) },
      { label: 'TIME',    value: fmtTime(booking.date_time) || '—' },
      { label: 'VEHICLE', value: (booking.vehicle_type || 'N/A').toUpperCase() },
      { label: 'STATUS',  value: 'COMPLETED', color: GREEN }
    ];
    const chipW = CW / chips.length;

    chips.forEach((chip, i) => {
      const x = ML + i * chipW;
      const cy = 114;
      doc.font('Helvetica').fontSize(7.5).fillColor(GRAY_400)
         .text(chip.label, x, cy, { width: chipW, lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(10).fillColor(chip.color || GRAY_800)
         .text(chip.value, x, cy + 14, { width: chipW, lineBreak: false });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // 4 ── TWO-COLUMN INFO BLOCK  (Billed To  |  Booking Summary)
    // ═══════════════════════════════════════════════════════════════════════════
    let y = 172;
    const COL_L  = ML;
    const COL_R  = ML + CW * 0.55;
    const COL_RW = CW * 0.42;

    // Section label helper
    function sectionLabel(text, cx, cy) {
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(GRAY_400)
         .text(text, cx, cy, { characterSpacing: 1.2 });
    }

    function labelVal(label, value, cx, cy, vColor) {
      doc.font('Helvetica').fontSize(8.5).fillColor(GRAY_400).text(label, cx, cy);
      doc.font('Helvetica-Bold').fontSize(10.5).fillColor(vColor || GRAY_800)
         .text(value || '—', cx, cy + 13);
    }

    // -- LEFT: Billed To
    sectionLabel('BILLED TO', COL_L, y);
    doc.moveTo(COL_L, y + 12).lineTo(COL_L + 180, y + 12).strokeColor(GRAY_200).lineWidth(0.75).stroke();

    const nameY = y + 20;
    doc.font('Helvetica-Bold').fontSize(14).fillColor(GRAY_800)
       .text(booking.guest_name || '—', COL_L, nameY);
    doc.font('Helvetica').fontSize(9.5).fillColor(GRAY_600)
       .text(booking.phone || '', COL_L, nameY + 20);
    if (booking.email) {
      doc.font('Helvetica').fontSize(9).fillColor(GRAY_400)
         .text(booking.email, COL_L, nameY + 36);
    }

    // -- RIGHT: Booking Summary card
    const cardX = COL_R - 4;
    const cardH = 86;
    doc.roundedRect(cardX, y - 4, COL_RW + 8, cardH, 6)
       .fillAndStroke(GRAY_100, GRAY_200);

    const rItems = [
      ['Booking ID',  bookingRef(booking.id)],
      ['Passengers',  `${booking.passengers || 1} pax`],
      ['Vehicle',     booking.vehicle_type || 'N/A']
    ];
    rItems.forEach(([lbl, val], i) => {
      const ry = y + 4 + i * 24;
      doc.font('Helvetica').fontSize(8.5).fillColor(GRAY_400)
         .text(lbl, COL_R + 4, ry);
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(GRAY_800)
         .text(val, COL_R + 4, ry + 11);
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // 5 ── DIVIDER
    // ═══════════════════════════════════════════════════════════════════════════
    y += 108;
    doc.moveTo(ML, y).lineTo(MR, y).strokeColor(GRAY_200).lineWidth(0.75).stroke();

    // ═══════════════════════════════════════════════════════════════════════════
    // 6 ── TRIP DETAILS SECTION
    // ═══════════════════════════════════════════════════════════════════════════
    y += 16;
    sectionLabel('TRIP DETAILS', ML, y);
    doc.moveTo(ML, y + 12).lineTo(MR, y + 12).strokeColor(GRAY_200).lineWidth(0.75).stroke();
    y += 22;

    // Route visualisation — left column
    const DOT_X = ML + 8;

    // Pickup dot (green filled)
    doc.circle(DOT_X, y + 6, 5).fill(GREEN);
    doc.font('Helvetica').fontSize(7.5).fillColor(GREEN)
       .text('PICKUP', ML + 20, y);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(GRAY_800)
       .text(booking.pickup || '—', ML + 20, y + 12, { width: CW * 0.7 });

    const pickupLines = doc.heightOfString(booking.pickup || '—',
      { width: CW * 0.7, font: 'Helvetica-Bold', size: 11 });

    // Connector line
    const lineTop    = y + 22;
    const lineBottom = y + 42 + Math.max(0, pickupLines - 14);
    doc.moveTo(DOT_X, lineTop).lineTo(DOT_X, lineBottom)
       .dash(3, { space: 3 })
       .strokeColor(GRAY_200).lineWidth(1.5).stroke();
    doc.undash();

    y = lineBottom + 8;

    // Dropoff dot (black filled)
    doc.circle(DOT_X, y + 6, 5).fill(GRAY_800);
    // inner white dot
    doc.circle(DOT_X, y + 6, 2).fill(WHITE);
    doc.font('Helvetica').fontSize(7.5).fillColor(GRAY_600)
       .text('DROP-OFF', ML + 20, y);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(GRAY_800)
       .text(booking.dropoff || '—', ML + 20, y + 12, { width: CW * 0.7 });

    const dropoffLines = doc.heightOfString(booking.dropoff || '—',
      { width: CW * 0.7, font: 'Helvetica-Bold', size: 11 });

    y += 14 + Math.max(14, dropoffLines);

    // ═══════════════════════════════════════════════════════════════════════════
    // 7 ── DRIVER ROW (conditional)
    // ═══════════════════════════════════════════════════════════════════════════
    if (booking.associated_member) {
      y += 14;
      doc.moveTo(ML, y).lineTo(MR, y).strokeColor(GRAY_200).lineWidth(0.75).stroke();
      y += 14;
      sectionLabel('DRIVER', ML, y);
      y += 14;
      // Driver avatar placeholder circle
      doc.circle(ML + 16, y + 16, 16).fill(GRAY_100);
      doc.font('Helvetica-Bold').fontSize(13).fillColor(GRAY_600)
         .text(booking.associated_member.charAt(0).toUpperCase(),
               ML + 10, y + 9, { width: 32, align: 'center', lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(11).fillColor(GRAY_800)
         .text(booking.associated_member, ML + 40, y + 8);
      doc.font('Helvetica').fontSize(9).fillColor(GRAY_400)
         .text('Your UrbanRide driver', ML + 40, y + 23);
      y += 46;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 8 ── THANK-YOU BANNER
    // ═══════════════════════════════════════════════════════════════════════════
    y += 20;
    doc.roundedRect(ML, y, CW, 46, 8).fill(GREEN_L);
    doc.font('Helvetica-Bold').fontSize(12).fillColor(GREEN)
       .text('Thank you for riding with UrbanRide!', ML, y + 10,
             { width: CW, align: 'center' });
    doc.font('Helvetica').fontSize(9).fillColor('#166534')
       .text('We hope to see you again soon.', ML, y + 27,
             { width: CW, align: 'center' });

    // ═══════════════════════════════════════════════════════════════════════════
    // 9 ── FOOTER
    // ═══════════════════════════════════════════════════════════════════════════
    const FOOTER_TOP = 810;
    doc.rect(0, FOOTER_TOP, W, 31.89).fill(BLACK);
    doc.font('Helvetica').fontSize(8).fillColor(GRAY_400)
       .text('UrbanRide Technologies  ·  This is an automated receipt  ·  © 2026 All rights reserved',
             0, FOOTER_TOP + 10, { width: W, align: 'center' });

    doc.end();
  });
}

// ── HTML email body ───────────────────────────────────────────────────────────
function buildHtml(booking) {
  const dt = booking.date_time
    ? new Date(booking.date_time).toLocaleString('en-IN', { dateStyle: 'long', timeStyle: 'short' })
    : '—';

  const ref = bookingRef(booking.id);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Your UrbanRide Receipt</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;background:#f0f2f5;color:#1f2937;-webkit-font-smoothing:antialiased}
  .wrap{max-width:560px;margin:32px auto;border-radius:16px;overflow:hidden;box-shadow:0 8px 40px rgba(0,0,0,.12)}
  /* Header */
  .hdr{background:#0a0a0a;padding:28px 32px;display:flex;align-items:center;justify-content:space-between}
  .hdr-brand{display:flex;align-items:center;gap:10px}
  .hdr-icon{width:38px;height:38px;background:#16a34a;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:900;color:#fff;letter-spacing:-1px}
  .hdr-name{font-size:18px;font-weight:700;color:#fff}
  .hdr-tagline{font-size:11px;color:#6b7280;margin-top:2px}
  .hdr-right{text-align:right}
  .hdr-invoice{font-size:11px;font-weight:700;letter-spacing:2px;color:#6b7280;text-transform:uppercase}
  .hdr-ref{font-size:20px;font-weight:800;color:#fff;margin-top:3px}
  /* Green stripe */
  .stripe{height:4px;background:linear-gradient(90deg,#16a34a,#22c55e)}
  /* Status bar */
  .status-bar{background:#f9fafb;border-bottom:1px solid #e5e7eb;padding:14px 32px;display:flex;align-items:center;gap:8px}
  .status-dot{width:9px;height:9px;background:#16a34a;border-radius:50%;box-shadow:0 0 0 3px rgba(22,163,74,.2)}
  .status-text{font-size:12px;font-weight:700;color:#166534;text-transform:uppercase;letter-spacing:.5px}
  .status-date{margin-left:auto;font-size:12px;color:#6b7280}
  /* Body */
  .body{background:#fff;padding:28px 32px}
  /* Section header */
  .sec-lbl{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#9ca3af;margin-bottom:14px}
  /* Info grid */
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px}
  .info-item .lbl{font-size:11px;color:#9ca3af;margin-bottom:3px}
  .info-item .val{font-size:14px;font-weight:600;color:#111827}
  /* Route block */
  .route-card{background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:20px;margin-bottom:24px;position:relative}
  .route-row{display:flex;align-items:flex-start;gap:14px}
  .route-icon{flex-shrink:0;width:32px;display:flex;flex-direction:column;align-items:center}
  .dot-green{width:10px;height:10px;background:#16a34a;border-radius:50%;margin-top:3px}
  .dot-black{width:10px;height:10px;background:#111827;border-radius:50%;border:2px solid #fff;box-shadow:0 0 0 2px #111827;margin-top:3px}
  .route-line{flex:1;width:2px;background:repeating-linear-gradient(180deg,#d1d5db 0,#d1d5db 4px,transparent 4px,transparent 8px);margin:6px 0;min-height:20px}
  .route-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#16a34a;margin-bottom:3px}
  .route-label.drop{color:#374151}
  .route-addr{font-size:13px;font-weight:600;color:#111827;line-height:1.4}
  /* Driver */
  .driver-row{display:flex;align-items:center;gap:12px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:14px;margin-bottom:24px}
  .driver-avatar{width:40px;height:40px;background:#e5e7eb;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;color:#374151;flex-shrink:0}
  .driver-name{font-size:13px;font-weight:600;color:#111827}
  .driver-sub{font-size:11px;color:#9ca3af;margin-top:2px}
  /* Thank-you banner */
  .thankyou{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:16px 20px;text-align:center;margin-bottom:8px}
  .thankyou-title{font-size:15px;font-weight:700;color:#166534}
  .thankyou-sub{font-size:12px;color:#4ade80;margin-top:4px;color:#16a34a}
  /* PDF note */
  .pdf-note{text-align:center;font-size:11px;color:#9ca3af;padding:12px 0 4px}
  /* Footer */
  .foot{background:#0a0a0a;padding:18px 32px;text-align:center;font-size:11px;color:#4b5563}
  .foot a{color:#6b7280;text-decoration:none}
  /* Divider */
  .divider{border:none;border-top:1px solid #f3f4f6;margin:20px 0}
</style>
</head>
<body>
<div class="wrap">

  <!-- Header -->
  <div class="hdr">
    <div class="hdr-brand">
      <div class="hdr-icon">U</div>
      <div>
        <div class="hdr-name">UrbanRide</div>
        <div class="hdr-tagline">Premium Cab Service</div>
      </div>
    </div>
    <div class="hdr-right">
      <div class="hdr-invoice">Invoice</div>
      <div class="hdr-ref">${ref}</div>
    </div>
  </div>
  <div class="stripe"></div>

  <!-- Status bar -->
  <div class="status-bar">
    <div class="status-dot"></div>
    <div class="status-text">Ride Completed</div>
    <div class="status-date">${dt}</div>
  </div>

  <!-- Body -->
  <div class="body">

    <!-- Passenger info -->
    <div class="sec-lbl">Passenger Details</div>
    <div class="grid2">
      <div class="info-item">
        <div class="lbl">Guest Name</div>
        <div class="val">${booking.guest_name || '—'}</div>
      </div>
      <div class="info-item">
        <div class="lbl">Phone</div>
        <div class="val">${booking.phone || '—'}</div>
      </div>
      <div class="info-item">
        <div class="lbl">Vehicle</div>
        <div class="val">${booking.vehicle_type || '—'}</div>
      </div>
      <div class="info-item">
        <div class="lbl">Passengers</div>
        <div class="val">${booking.passengers || 1} pax</div>
      </div>
    </div>

    <hr class="divider">

    <!-- Route -->
    <div class="sec-lbl">Trip Route</div>
    <div class="route-card">
      <!-- Pickup -->
      <div class="route-row">
        <div class="route-icon">
          <div class="dot-green"></div>
          <div class="route-line"></div>
        </div>
        <div>
          <div class="route-label">Pickup</div>
          <div class="route-addr">${booking.pickup || '—'}</div>
        </div>
      </div>
      <!-- Dropoff -->
      <div class="route-row" style="margin-top:10px">
        <div class="route-icon">
          <div class="dot-black"></div>
        </div>
        <div>
          <div class="route-label drop">Drop-off</div>
          <div class="route-addr">${booking.dropoff || '—'}</div>
        </div>
      </div>
    </div>

    ${booking.associated_member ? `
    <hr class="divider">
    <div class="sec-lbl">Driver</div>
    <div class="driver-row">
      <div class="driver-avatar">${booking.associated_member.charAt(0).toUpperCase()}</div>
      <div>
        <div class="driver-name">${booking.associated_member}</div>
        <div class="driver-sub">Your UrbanRide driver</div>
      </div>
    </div>` : ''}

    <!-- Thank you -->
    <div class="thankyou">
      <div class="thankyou-title">Thank you for riding with UrbanRide! 🚗</div>
      <div class="thankyou-sub">Your invoice is attached as a PDF for your records.</div>
    </div>
    <div class="pdf-note">📎 Invoice PDF attached — ${ref}</div>

  </div>

  <!-- Footer -->
  <div class="foot">
    UrbanRide Technologies &nbsp;·&nbsp; This is an automated receipt &nbsp;·&nbsp; © 2026
  </div>

</div>
</body>
</html>`;
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
    subject: `Your UrbanRide receipt — ${bookingRef(booking.id)}`,
    html:    buildHtml(booking),
    attachments: [{
      filename:    `UrbanRide_Invoice_${bookingRef(booking.id)}.pdf`,
      content:     pdfBuffer,
      contentType: 'application/pdf'
    }]
  });

  logger.info({ event: 'invoice_email_sent', rideId: booking.id, to: booking.email });
}

module.exports = { sendRideCompleteEmail };
