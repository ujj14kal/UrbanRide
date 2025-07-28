// At the very top of your vc.js file
require('dotenv').config(); // Load environment variables from .env file

const amqp = require('amqplib');
const mysql = require('mysql2'); // <--- IMPORTANT: Changed to mysql2
const readline = require('readline');
const generateAndSendInvoice = require('./invoice'); // ⬅️ Invoice module - ensure this file exists
const fs = require('fs'); // Required for reading SSL CA certificate if you choose Option B for MySQL

const queue = 'booking_requests'; // The RabbitMQ queue name

// =========================================================
// 🔌 MySQL connection setup for Railway (using .env)
// ---------------------------------------------------------
// Access credentials from process.env
const MYSQL_HOST = process.env.MYSQLHOST;
const MYSQL_PORT = parseInt(process.env.MYSQLPORT, 10); // Port should be a number
const MYSQL_USER = process.env.MYSQLUSER;
const MYSQL_PASSWORD = process.env.MYSQLPASSWORD;
const MYSQL_DATABASE = process.env.MYSQLDATABASE; // Using MYSQLDATABASE from your .env

// --- MySQL SSL Configuration (CHOOSE ONE OPTION BELOW) ---
let mysqlConfig;

// OPTION A (RECOMMENDED FOR mysql2 & Railway): Use SSL but rejectUnauthorized: false
// mysql2 generally handles caching_sha2_password when SSL is enabled.
mysqlConfig = {
    host: MYSQL_HOST,
    port: MYSQL_PORT,
    user: MYSQL_USER,
    password: MYSQL_PASSWORD,
    database: MYSQL_DATABASE,
    ssl: {
        rejectUnauthorized: false // <--- This is often enough for mysql2 with Railway's self-signed certs
    },
    // IMPORTANT: Remove any authPlugins or authProtocol properties you added for 'mysql'
    // mysql2 handles the authentication plugin automatically when SSL is configured.
};

/*
// OPTION B: Use Railway's CA Certificate (MORE SECURE - If you have the CA cert file)
// You would also put the path to your CA cert in the .env file if you use this.
// Example in .env: MYSQL_CA_CERT_PATH=./certs/ca.pem
const MYSQL_CA_CERT_PATH = process.env.MYSQL_CA_CERT_PATH || './certs/ca.pem'; // Default if not in .env
try {
    const caCert = fs.readFileSync(MYSQL_CA_CERT_PATH);
    mysqlConfig = {
        host: MYSQL_HOST,
        port: MYSQL_PORT,
        user: MYSQL_USER,
        password: MYSQL_PASSWORD,
        database: MYSQL_DATABASE,
        ssl: {
            ca: caCert
        }
    };
} catch (error) {
    console.error(`❌ Error reading CA certificate at ${MYSQL_CA_CERT_PATH}:`, error.message);
    console.error('Please ensure the CA certificate file exists and the path is correct.');
    process.exit(1);
}
*/
// =========================================================


// For mysql2, use .createConnection() or .createPool() for a single connection,
// or a pool for multiple connections. For vc.js, createConnection is fine.
const db = mysql.createConnection(mysqlConfig);

db.connect((err) => {
    if (err) {
        console.error('❌ MySQL connection failed:', err);
        process.exit(1); // Exit if DB connection fails
    }
    console.log('✅ Connected to Railway MySQL');
});

// =========================================================
// 🔗 RabbitMQ connection setup for Railway (using .env)
// ---------------------------------------------------------
// Access RABBITMQ_URL from process.env
const RABBITMQ_URL = process.env.RABBITMQ_URL;

if (!RABBITMQ_URL) {
    console.error("❌ RABBITMQ_URL environment variable is not set.");
    console.error("Please ensure RABBITMQ_URL is present in your .env file with the correct connection string.");
    process.exit(1); // Exit if RabbitMQ URL is missing
}

// =========================================================

async function listenForBookings() {
    let connection;
    try {
        // Connect to Railway RabbitMQ using the URL from .env
        connection = await amqp.connect(RABBITMQ_URL);
        const channel = await connection.createChannel();
        await channel.assertQueue(queue, { durable: true });

        console.log('🔔 Waiting for bookings in queue:', queue);

        channel.consume(queue, async (msg) => {
            const booking = JSON.parse(msg.content.toString());
            console.log('\n📦 Received booking:\n', booking);

            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
            });

            rl.question('🛠️ Vendor decision (accept / reject / open_market): ', (decisionRaw) => {
                const decision = decisionRaw.trim().toLowerCase();

                if (!['accept', 'reject', 'open_market'].includes(decision)) {
                    console.log('⚠️ Invalid decision. Use: accept / reject / open_market');
                    rl.close();
                    return channel.nack(msg); // Nack (requeue) message if invalid decision
                }

                const status = decision === 'accept' ? 'accepted' :
                               decision === 'reject' ? 'rejected' : 'open_market';

                const bookingId = booking.id;

                // For mysql2, db.query often returns a promise, but the callback style also works.
                db.query(
                    'UPDATE rides SET status = ? WHERE id = ?',
                    [status, bookingId],
                    (err, result) => {
                        if (err) {
                            console.error('❌ Failed to update booking status in DB:', err);
                            channel.nack(msg, false, true); // Nack and requeue
                        } else {
                            console.log(`✅ Booking ID ${bookingId} marked as: ${status.toUpperCase()}`);

                            if (status === 'accepted') {
                                db.query('SELECT * FROM rides WHERE id = ?', [bookingId], (err, rows) => {
                                    if (err || rows.length === 0) {
                                        console.error('❌ Could not retrieve booking details for invoice');
                                    } else {
                                        const ride = rows[0];

                                        const invoiceBookingData = {
                                            id: ride.id,
                                            guest_name: ride.guest_name,
                                            phone: ride.phone,
                                            pickup: ride.pickup,
                                            dropoff: ride.dropoff,
                                            associated_member: ride.associated_member,
                                            email: ride.email
                                        };

                                        generateAndSendInvoice(invoiceBookingData)
                                            .then(() => console.log(`📧 Invoice sent for booking ID ${ride.id}`))
                                            .catch((err) => console.error('❌ Invoice sending failed:', err));
                                    }
                                });
                            }
                            channel.ack(msg);
                        }
                        rl.close();
                    }
                );
            });
        }, { noAck: false });
    } catch (error) {
        console.error('❌ Failed to connect to RabbitMQ or consumer error:', error);
        if (connection) {
            await connection.close();
        }
        process.exit(1);
    }
}

listenForBookings().catch(console.error);