const amqp = require('amqplib');
const mysql = require('mysql');
const readline = require('readline');

const queue = 'booking_requests';

// 🔌 MySQL connection setup (update if needed)
const db = mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: 'Ujj$4193', // ← your DB password if any
  database: 'urbanride', // ← change this to your DB name
});

db.connect((err) => {
  if (err) {
    console.error('❌ MySQL connection failed:', err);
    process.exit(1);
  }
  console.log('✅ Connected to MySQL');
});

async function listenForBookings() {
  const connection = await amqp.connect('amqp://localhost');
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
        return channel.nack(msg); // requeue message
      }

      const status = decision === 'accept' ? 'accepted' :
                     decision === 'reject' ? 'rejected' : 'open_market';

      const bookingId = booking.id;

      db.query(
        'UPDATE rides SET status = ? WHERE id = ?',
        [status, bookingId],
        (err, result) => {
          if (err) {
            console.error('❌ Failed to update booking status in DB:', err);
          } else {
            console.log(`✅ Booking ID ${bookingId} marked as: ${status.toUpperCase()}`);
            channel.ack(msg);
          }
          rl.close();
        }
      );
    });
  });
}

listenForBookings().catch(console.error);

