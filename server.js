const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const bodyParser = require('body-parser');
const path = require('path');
const axios = require('axios');

// ✅ Import database connection
const db = require('./db'); // adjust if needed
const bookingRoutes = require('./booking'); // Assuming this handles other booking operations

const invoiceRouter = require('./invoiceRouter');

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

// Add this line to enable invoice routes
app.use('/invoice', invoiceRouter);

// Removed: Redundant API Endpoint to get booking status by ID
// app.get('/booking-status/:id', async (req, res) => {
//     const bookingId = req.params.id;
//     try {
//         const [rows] = await db.query('SELECT status FROM rides WHERE id = ?', [bookingId]);
//         if (rows.length > 0) {
//             res.json({ status: rows[0].status });
//         } else {
//             res.status(404).json({ error: 'Booking not found' });
//         }
//     } catch (error) {
//         console.error('Error fetching booking status:', error.message);
//         res.status(500).json({ error: 'Failed to fetch booking status' });
//     }
// });


// ✅ Directions API Endpoint
app.post('/directions', async (req, res) => {
    const { origin, destination } = req.body;

    if (!origin || !destination) {
        return res.status(400).json({ error: 'Origin and destination are required.' });
    }

    const apiKey = process.env.Maps_API_KEY;
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

// ✅ Booking routes (This is where /api/bookings?id=... is handled)
app.use('/api/bookings', bookingRoutes);


// ✅ TELEGRAM WEBHOOK HANDLER
app.post('/telegram-update', async (req, res) => {
    const message = req.body.message;

    if (!message || !message.text) return res.sendStatus(200);

    const chatId = message.chat.id;
    const text = message.text.trim();

    const match = text.match(/^\/(accept|reject|openmarket)_(\d+)$/);
    if (!match) return res.sendStatus(200); // ignore unrelated messages

    const action = match[1]; // accept/reject/openmarket
    const bookingId = match[2];

    let newStatus = '';
    if (action === 'accept') newStatus = 'accepted';
    else if (action === 'reject') newStatus = 'rejected';
    else if (action === 'openmarket') newStatus = 'open_market';

    try {
        await db.query('UPDATE rides SET status = ? WHERE id = ?', [newStatus, bookingId]);

        // Send reply back to Telegram (optional)
        await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: chatId,
            text: `✅ Booking ${bookingId} marked as *${newStatus}*`,
            parse_mode: 'Markdown'
        });

        return res.sendStatus(200);
    } catch (err) {
        console.error('Failed to update DB from Telegram:', err.message);
        return res.sendStatus(500);
    }
});

// ✅ Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`UrbanRide backend is live on port ${PORT}`);
});