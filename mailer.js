// mailer.js — Invoice email sent to rider when driver ends the ride
//
// Uses Brevo (formerly Sendinblue) Transactional Email HTTP API — free 300/day.
// No SMTP ports used so it works on Render's free tier without any port issues.
//
// Required env vars on Render:
//   BREVO_API_KEY — from brevo.com → SMTP & API → API Keys
//   EMAIL_USER    — verified sender address on Brevo (urbanride.invoice@gmail.com)
//
// Setup (one-time, ~2 min):
//   1. Sign up free at brevo.com
//   2. Senders & IP → Senders → add + verify urbanride.invoice@gmail.com
//   3. SMTP & API → API Keys → create key → copy it
//   4. Add BREVO_API_KEY to Render environment variables

const axios       = require('axios');
const PDFDocument = require('pdfkit');
const path        = require('path');
const logger      = require('./logger');

const BREVO_SEND_URL = 'https://api.brevo.com/v3/smtp/email';

function getBrevoKey() {
  return process.env.BREVO_API_KEY || null;
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

// ── HTML email body (table-based, all styles inline — works in Gmail/iOS/Outlook)
function buildHtml(booking) {
  const dt  = booking.date_time
    ? new Date(booking.date_time).toLocaleString('en-IN', { dateStyle: 'long', timeStyle: 'short' })
    : '—';
  const ref = bookingRef(booking.id);

  const driverRow = booking.associated_member ? `
    <tr><td style="padding:0 32px">
      <table width="100%" cellpadding="0" cellspacing="0" border="0"
             style="border:1px solid #e5e7eb;border-radius:10px;background:#f9fafb">
        <tr>
          <td width="48" style="padding:14px 0 14px 14px;vertical-align:middle">
            <table cellpadding="0" cellspacing="0" border="0">
              <tr><td width="40" height="40" align="center" valign="middle"
                      style="background:#e5e7eb;border-radius:50%;font-size:16px;font-weight:700;color:#374151">
                ${booking.associated_member.charAt(0).toUpperCase()}
              </td></tr>
            </table>
          </td>
          <td style="padding:14px;vertical-align:middle">
            <div style="font-size:13px;font-weight:600;color:#111827">${booking.associated_member}</div>
            <div style="font-size:11px;color:#9ca3af;margin-top:2px">Your UrbanRide driver</div>
          </td>
        </tr>
      </table>
    </td></tr>
    <tr><td style="padding:0 32px"><div style="height:1px;background:#f3f4f6;margin:20px 0"></div></td></tr>
  ` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Your UrbanRide Receipt</title>
</head>
<body style="margin:0;padding:0;background:#f0f2f5;font-family:Arial,Helvetica,sans-serif">

<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f0f2f5">
<tr><td align="center" style="padding:32px 16px">

  <table width="560" cellpadding="0" cellspacing="0" border="0"
         style="max-width:560px;width:100%;border-radius:14px;overflow:hidden;background:#ffffff">

    <!-- ── HEADER ── -->
    <tr>
      <td bgcolor="#0a0a0a" style="padding:24px 32px">
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="vertical-align:middle">
              <table cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td width="44" style="vertical-align:middle">
                    <img src="https://urbanride.onrender.com/images/logo.png"
                         alt="UrbanRide" width="44" height="44"
                         style="display:block;border-radius:8px" />
                  </td>
                  <td style="padding-left:10px;vertical-align:middle">
                    <div style="font-size:18px;font-weight:700;color:#ffffff">UrbanRide</div>
                    <div style="font-size:11px;color:#6b7280;margin-top:2px">Premium Cab Service</div>
                  </td>
                </tr>
              </table>
            </td>
            <td align="right" style="vertical-align:middle">
              <div style="font-size:10px;font-weight:700;letter-spacing:2px;color:#6b7280;text-transform:uppercase">Invoice</div>
              <div style="font-size:20px;font-weight:800;color:#ffffff;margin-top:3px">${ref}</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- ── GREEN STRIPE ── -->
    <tr><td bgcolor="#16a34a" height="4" style="font-size:0;line-height:0">&nbsp;</td></tr>

    <!-- ── STATUS BAR ── -->
    <tr>
      <td bgcolor="#f9fafb" style="padding:12px 32px;border-bottom:1px solid #e5e7eb">
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="vertical-align:middle">
              <table cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td width="10" height="10" style="background:#16a34a;border-radius:50%;font-size:0">&nbsp;</td>
                  <td style="padding-left:8px;font-size:12px;font-weight:700;color:#166534;text-transform:uppercase;letter-spacing:.5px">
                    &#10003; Ride Completed
                  </td>
                </tr>
              </table>
            </td>
            <td align="right" style="font-size:12px;color:#6b7280">${dt}</td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- ── PASSENGER DETAILS ── -->
    <tr>
      <td style="padding:24px 32px 0">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#9ca3af;margin-bottom:16px">
          Passenger Details
        </div>
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td width="50%" style="padding-bottom:16px;vertical-align:top">
              <div style="font-size:11px;color:#9ca3af;margin-bottom:3px">Guest Name</div>
              <div style="font-size:14px;font-weight:600;color:#111827">${booking.guest_name || '—'}</div>
            </td>
            <td width="50%" style="padding-bottom:16px;vertical-align:top">
              <div style="font-size:11px;color:#9ca3af;margin-bottom:3px">Phone</div>
              <div style="font-size:14px;font-weight:600;color:#111827">${booking.phone || '—'}</div>
            </td>
          </tr>
          <tr>
            <td width="50%" style="vertical-align:top">
              <div style="font-size:11px;color:#9ca3af;margin-bottom:3px">Vehicle</div>
              <div style="font-size:14px;font-weight:600;color:#111827">${booking.vehicle_type || '—'}</div>
            </td>
            <td width="50%" style="vertical-align:top">
              <div style="font-size:11px;color:#9ca3af;margin-bottom:3px">Passengers</div>
              <div style="font-size:14px;font-weight:600;color:#111827">${booking.passengers || 1} pax</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- ── DIVIDER ── -->
    <tr><td style="padding:0 32px"><div style="height:1px;background:#f3f4f6;margin:20px 0"></div></td></tr>

    <!-- ── TRIP ROUTE ── -->
    <tr>
      <td style="padding:0 32px">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#9ca3af;margin-bottom:14px">
          Trip Route
        </div>
        <table width="100%" cellpadding="0" cellspacing="0" border="0"
               style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px">
          <tr>
            <td style="padding:16px 20px">

              <!-- Pickup row -->
              <table cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <td width="24" style="vertical-align:top;padding-top:4px">
                    <table cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td width="10" height="10" align="center"
                            style="background:#16a34a;border-radius:50%;font-size:0">&nbsp;</td>
                      </tr>
                      <tr>
                        <td align="center" style="padding:3px 0">
                          <div style="width:2px;height:22px;background:#d1d5db;margin:0 auto"></div>
                        </td>
                      </tr>
                    </table>
                  </td>
                  <td style="padding-left:12px;vertical-align:top">
                    <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#16a34a;margin-bottom:3px">Pickup</div>
                    <div style="font-size:13px;font-weight:600;color:#111827;line-height:1.4;padding-bottom:14px">${booking.pickup || '—'}</div>
                  </td>
                </tr>
              </table>

              <!-- Dropoff row -->
              <table cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <td width="24" style="vertical-align:top;padding-top:4px">
                    <div style="width:10px;height:10px;background:#111827;border-radius:50%"></div>
                  </td>
                  <td style="padding-left:12px;vertical-align:top">
                    <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#374151;margin-bottom:3px">Drop-off</div>
                    <div style="font-size:13px;font-weight:600;color:#111827;line-height:1.4">${booking.dropoff || '—'}</div>
                  </td>
                </tr>
              </table>

            </td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- ── DIVIDER ── -->
    <tr><td style="padding:0 32px"><div style="height:1px;background:#f3f4f6;margin:20px 0"></div></td></tr>

    <!-- ── DRIVER (conditional) ── -->
    ${driverRow}

    <!-- ── THANK YOU ── -->
    <tr>
      <td style="padding:0 32px 8px">
        <table width="100%" cellpadding="0" cellspacing="0" border="0"
               style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px">
          <tr>
            <td style="padding:16px 20px;text-align:center">
              <div style="font-size:15px;font-weight:700;color:#166534">Thank you for riding with UrbanRide! 🚗</div>
              <div style="font-size:12px;color:#16a34a;margin-top:4px">Your invoice PDF is attached for your records.</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- ── PDF NOTE ── -->
    <tr>
      <td style="padding:10px 32px 20px;text-align:center;font-size:11px;color:#9ca3af">
        &#128206; Invoice PDF attached — ${ref}
      </td>
    </tr>

    <!-- ── FOOTER ── -->
    <tr>
      <td bgcolor="#0a0a0a" style="padding:18px 32px;text-align:center;font-size:11px;color:#4b5563">
        UrbanRide Technologies &nbsp;&middot;&nbsp; Automated receipt &nbsp;&middot;&nbsp; &copy; 2026
      </td>
    </tr>

  </table>

</td></tr>
</table>

</body>
</html>`;
}

// ── Main export ───────────────────────────────────────────────────────────────
async function sendRideCompleteEmail(booking) {
  const recipient = booking.email || process.env.EMAIL_USER;
  if (!recipient) {
    logger.info({ event: 'email_skipped', reason: 'no recipient', rideId: booking.id });
    return;
  }

  const apiKey = getBrevoKey();
  if (!apiKey) {
    logger.warn({ event: 'email_skipped', reason: 'BREVO_API_KEY not set', rideId: booking.id });
    return;
  }

  const senderEmail = process.env.EMAIL_USER || 'urbanride.invoice@gmail.com';
  const pdfBuffer   = await buildInvoiceBuffer(booking);
  const ref         = bookingRef(booking.id);

  await axios.post(BREVO_SEND_URL, {
    sender:      { name: 'UrbanRide', email: senderEmail },
    to:          [{ email: recipient, name: booking.guest_name || 'Rider' }],
    subject:     `Your UrbanRide receipt — ${ref}`,
    htmlContent: buildHtml(booking),
    attachment:  [{
      name:    `UrbanRide_Invoice_${ref}.pdf`,
      content: pdfBuffer.toString('base64')
    }]
  }, {
    headers: {
      'api-key':      apiKey,
      'content-type': 'application/json',
      'accept':       'application/json'
    }
  });

  logger.info({ event: 'invoice_email_sent', rideId: booking.id, to: recipient });
}

module.exports = { sendRideCompleteEmail };
