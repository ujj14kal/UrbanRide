const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const bodyParser = require('body-parser');
const bookingRoutes = require('./booking');

dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ✅ Serve static files from 'public'
app.use(express.static('public'));

// ✅ Serve index.html from /html on root URL
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/html/index.html');
});

// API route
app.use('/bookings', bookingRoutes);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});



