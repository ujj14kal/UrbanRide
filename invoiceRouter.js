const express = require('express');
const path = require('path');
const fs = require('fs');
const router = express.Router();

router.get('/:id', (req, res) => {
  const invoicePath = path.join(process.cwd(), 'invoices', `invoice_${req.params.id}.pdf`);

  if (fs.existsSync(invoicePath)) {
    res.sendFile(invoicePath);
  } else {
    res.status(404).send('Invoice not found');
  }
});

module.exports = router;
