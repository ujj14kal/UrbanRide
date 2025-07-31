// invoice.js (or invoiceGenerator.js)

const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

async function generateInvoice(booking) {
  return new Promise((resolve, reject) => {
    try {
      const invoicesDir = path.join(process.cwd(), 'invoices');
      if (!fs.existsSync(invoicesDir)) fs.mkdirSync(invoicesDir);

      const invoicePath = path.join(invoicesDir, `invoice_${booking.id}.pdf`);
      const doc = new PDFDocument();

      const stream = fs.createWriteStream(invoicePath);
      doc.pipe(stream);

      doc.fontSize(20).text('UrbanRide Invoice', { align: 'center' });
      doc.moveDown();

      doc.fontSize(14).text(`Booking ID: ${booking.id}`);
      doc.text(`Guest Name: ${booking.guest_name}`);
      doc.text(`Phone: ${booking.phone}`);
      doc.text(`Pickup: ${booking.pickup}`);
      doc.text(`Dropoff: ${booking.dropoff}`);
      doc.text(`Associated Member: ${booking.associated_member || 'N/A'}`);

      doc.end();

      stream.on('finish', () => {
        console.log(`Invoice generated at ${invoicePath}`);
        resolve(invoicePath);
      });

      stream.on('error', reject);
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generateInvoice };
