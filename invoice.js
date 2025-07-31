// invoice.js
const fs = require('fs');
const path = require('path');
const express = require('express');
const router = express.Router();

// Serve the PDF invoice if it exists
router.get('/:id', (req, res) => {
  const invoicePath = path.join(process.cwd(), 'invoices', `invoice_${req.params.id}.pdf`);

  if (fs.existsSync(invoicePath)) {
    res.sendFile(invoicePath);
  } else {
    res.status(404).send('Invoice not found');
  }
});

module.exports = router;