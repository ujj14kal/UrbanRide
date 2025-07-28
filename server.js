const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const bodyParser = require('body-parser');
const path = require('path');

const bookingRoutes = require('./booking');

dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ✅ Serve all static files from /public/html
app.use(express.static(path.join(__dirname, 'public/html')));

// ✅ Default route - send index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/html', 'index.html'));
});

// ✅ Your API routes
app.use('/bookings', bookingRoutes);

// ✅ Start the server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`UrbanRide backend is live on port ${PORT}`);
});



