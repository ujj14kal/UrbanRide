const PDFDocument = require('pdfkit');
const path = require('path');

function generateInvoiceStream(booking, res) {
  const doc = new PDFDocument({ margin: 50 });

  // Stream PDF to browser
  doc.pipe(res);

  // === 1. Add Logo ===
  const logoPath = path.join(__dirname, 'public', 'images', 'urbanride_logo.png');
  doc.image(logoPath, doc.page.width / 2 - 50, 20, { width: 100 }); // Centered

  // === 2. Heading ===
  doc.moveDown(3);
  doc.font('Helvetica-Bold') // Closest to Uber's app header
     .fontSize(22)
     .fillColor('#000000')
     .text('UrbanRide Invoice', { align: 'center' });

  doc.moveDown(1);

  // === 3. Horizontal Line ===
  doc.lineWidth(1)
     .strokeColor('#cccccc')
     .moveTo(50, doc.y)
     .lineTo(550, doc.y)
     .stroke();

  doc.moveDown(1.5);

  // === 4. Booking Details ===
  doc.font('Helvetica')
     .fontSize(13)
     .fillColor('#333333');

  doc.text(`📄 Booking ID: ${booking.id}`);
  doc.text(`👤 Guest Name: ${booking.guest_name}`);
  doc.text(`📞 Phone: ${booking.phone}`);
  doc.text(`📍 Pickup Location: ${booking.pickup}`);
  doc.text(`🏁 Dropoff Location: ${booking.dropoff}`);
  doc.text(`👥 Associated Member: ${booking.associated_member || 'N/A'}`);

  // === 5. Footer ===
  doc.moveDown(2);
  doc.fontSize(10).fillColor('#888888');
  doc.text('Thank you for choosing UrbanRide!', { align: 'center' });

  // Finalize
  doc.end();
}

module.exports = { generateInvoiceStream };
