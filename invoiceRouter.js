const express = require('express');
const router = express.Router();
const { generateInvoiceStream } = require('./invoice'); // Make sure invoice.js exports this function
const db = require('./db'); // Adjust based on where your DB connection is

// Route: /invoice/:id
router.get('/:id', async (req, res) => {
  const invoiceId = req.params.id;

  try {
    const [rows] = await db.query('SELECT * FROM rides WHERE id = ?', [invoiceId]);

    if (!rows.length) {
      return res.status(404).send('Booking not found');
    }

    const booking = rows[0];

    // Set headers to trigger browser download
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=invoice_${invoiceId}.pdf`);

    // Pipe PDF directly to response
    generateInvoiceStream(res, booking);
  } catch (err) {
    console.error(`❌ Error generating invoice ${invoiceId}:`, err);
    res.status(500).send('Failed to generate invoice');
  }
});

module.exports = router;
