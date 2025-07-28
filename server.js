const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const bodyParser = require('body-parser');

const bookingRoutes = require('./booking');

dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

app.use('/bookings', bookingRoutes); // ✅ valid route

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});


