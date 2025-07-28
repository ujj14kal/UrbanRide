const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const bodyParser = require('body-parser');
const path = require('path');
const axios = require('axios');

const bookingRoutes = require('./booking');

dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ✅ Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// ✅ Default route - index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/html', 'index.html'));
});

// ✅ Directions API Endpoint (new)
app.post('/directions', async (req, res) => {
  const { origin, destination } = req.body;

  if (!origin || !destination) {
    return res.status(400).json({ error: 'Origin and destination are required.' });
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${origin}&destination=${destination}&key=${apiKey}&traffic_model=best_guess&departure_time=now`;

  try {
    const response = await axios.get(url);
    const data = response.data;

    if (data.routes.length === 0) {
      return res.status(404).json({ error: 'No route found.' });
    }

    const leg = data.routes[0].legs[0];
    return res.json({
      distance: leg.distance.text,
      duration: leg.duration.text,
      duration_in_traffic: leg.duration_in_traffic ? leg.duration_in_traffic.text : leg.duration.text
    });
  } catch (error) {
    console.error('Directions API error:', error.message);
    return res.status(500).json({ error: 'Failed to fetch directions.' });
  }
});

// ✅ API routes for bookings
app.use('/bookings', bookingRoutes);

// ✅ Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`UrbanRide backend is live on port ${PORT}`);
});

