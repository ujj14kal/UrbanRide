const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const bookingRoutes = require('./booking');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, 'public')));

app.use(cors());
app.use(express.json());

app.use('/api/bookings', bookingRoutes);

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});


