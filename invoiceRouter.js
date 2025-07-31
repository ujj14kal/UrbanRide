const express = require('express');
const path = require('path');
const fs = require('fs');
const router = express.Router();

router.get('/:id', (req, res) => {
  const invoiceId = req.params.id; // Store the ID for filename
  const invoicePath = path.join(process.cwd(), 'invoices', `invoice_${invoiceId}.pdf`);

  if (fs.existsSync(invoicePath)) {
    // ⭐ IMPORTANT: CHANGE THIS LINE FROM res.sendFile TO res.download ⭐
    res.download(invoicePath, `invoice_${invoiceId}.pdf`, (err) => {
      if (err) {
        console.error(`❌ Error downloading invoice ${invoiceId}:`, err);
        // Handle specific error codes or just send a generic 500
        if (err.code === 'ENOENT') { // File not found on the server
          return res.status(404).send('Invoice file not found on server.');
        }
        res.status(500).send('Failed to download invoice.');
      } else {
        console.log(`✅ Invoice ${invoiceId}.pdf sent successfully.`);
      }
    });
  } else {
    console.warn(`⚠️ Invoice file not found at: ${invoicePath}`);
    res.status(404).send('Invoice not found');
  }
});

module.exports = router;