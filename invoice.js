// invoice.js (Stream version for direct download)

const PDFDocument = require('pdfkit');

function generateInvoiceStream(res, booking) {
  const doc = new PDFDocument();

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=invoice_${booking.id}.pdf`);

  doc.pipe(res);

  doc.fontSize(20).text('UrbanRide Invoice', { align: 'center' });
  doc.moveDown();

  doc.fontSize(14).text(`Booking ID: ${booking.id}`);
  doc.text(`Guest Name: ${booking.guest_name}`);
  doc.text(`Phone: ${booking.phone}`);
  doc.text(`Pickup: ${booking.pickup}`);
  doc.text(`Dropoff: ${booking.dropoff}`);
  doc.text(`Associated Member: ${booking.associated_member || 'N/A'}`);

  doc.end();
}

module.exports = { generateInvoiceStream };
