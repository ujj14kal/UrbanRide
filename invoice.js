const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

async function generateAndSendInvoice(booking) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const filePath = path.join(__dirname, `invoice_${booking.id}.pdf`);
    const stream = fs.createWriteStream(filePath);

    doc.pipe(stream);

    // 🖼️ Add logo
    doc.image(path.join(__dirname, 'logo.png'), 50, 30, { width: 100 });

    // Add vertical space between logo and title
    doc.moveDown(3);

    // 🧾 Title
    doc
      .fontSize(24)
      .fillColor('#222')
      .text('Invoice', 50, doc.y);

    doc.moveDown(1);

    // 🎨 Light gray rounded background box
    const boxX = 50;
    const boxY = doc.y;
    const boxWidth = 500;
    const boxHeight = 160;

    doc.save();
    doc
      .roundedRect(boxX, boxY, boxWidth, boxHeight, 8)
      .fill('#f5f5f5');
    doc.restore();

    // ✏️ Text inside the box
    const textLeft = boxX + 15;
    let textTop = boxY + 15;
    const lineGap = 20;

    doc
      .fontSize(12)
      .fillColor('#000')
      .text(`Booking ID:        ${booking.id}`, textLeft, textTop);
    textTop += lineGap;
    doc.text(`Guest Name:        ${booking.guest_name}`, textLeft, textTop);
    textTop += lineGap;
    doc.text(`Phone:             ${booking.phone}`, textLeft, textTop);
    textTop += lineGap;
    doc.text(`Pickup Location:   ${booking.pickup}`, textLeft, textTop);
    textTop += lineGap;
    doc.text(`Dropoff Location:  ${booking.dropoff}`, textLeft, textTop);
    textTop += lineGap;
    doc.text(`Associated Member: ${booking.associated_member}`, textLeft, textTop);

    doc.moveDown(6);

    // Footer
    doc
      .fontSize(10)
      .fillColor('#666')
      .text('Thank you for riding with UrbanRide!', 50, doc.page.height - 100, {
        align: 'center'
      });

    doc.end();

    stream.on('finish', () => {
      sendEmail(booking.email, booking.guest_name, filePath)
        .then(() => {
          fs.unlinkSync(filePath); // Clean up file
          resolve();
        })
        .catch(reject);
    });
  });
}

async function sendEmail(to, guestName, filePath) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: 'urban.ride14@gmail.com',
      pass: 'uobdiggfpouekfjr' // App password
    }
  });

  const mailOptions = {
    from: 'UrbanRide <urban.ride14@gmail.com>',
    to,
    subject: 'Your UrbanRide Invoice',
    text: `Greetings ${guestName},

Here is your invoice for today's ride.

Regards,
Team UrbanRide`,
    attachments: [
      {
        filename: path.basename(filePath),
        path: filePath
      }
    ]
  };

  await transporter.sendMail(mailOptions);
}

module.exports = generateAndSendInvoice;

