const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const bodyParser = require('body-parser');

const bookingRoutes = require('./booking');

dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Mount your booking routes
app.use('/bookings', bookingRoutes);

// Add this root route to handle GET /
app.get('/', (req, res) => {
  res.send('UrbanRide backend is live!');
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});


