const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const bookingRoutes = require('./booking'); // change path if needed

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

app.use('/api/bookings', bookingRoutes);

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});


