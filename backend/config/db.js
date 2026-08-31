const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'kl_electricals',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  timezone: 'Z',
  dateStrings: true,
});

// With dateStrings: true, mysql2 hands back DATETIME columns as the raw strings
// MySQL stored — no JS-side timezone conversion happens. NOW() is evaluated in
// the MySQL session's own time_zone, which on shared hosting is whatever the
// host set. The client treats every stored string as UTC (it appends 'Z' before
// parsing), so each connection's session must actually be UTC for NOW()-based
// columns (checkin_time, checkout_time, recorded_at) to read back correctly.
// Remove this hook and every timestamp in the app shifts by the host's offset.
//
// mysql2 runs commands on a connection in the order they were queued, so this
// SET completes before any query the pool later hands that connection. What it
// did NOT do is report a failure: with no callback, an error here surfaced as
// an unhandled 'error' event on the pool rather than something diagnosable.
// Failing loudly matters — a connection that silently kept the host's time zone
// would write correct-looking timestamps that are wrong by the host's offset.
// STRICT_TRANS_TABLES is set for the same reason and is just as load-bearing.
//
// XAMPP's MariaDB ships with a non-strict sql_mode, and non-strict means every
// invalid write is silently COERCED instead of refused:
//
//   · an enum value that is not in the list becomes the empty string ''
//   · a string longer than the column is truncated
//   · a number out of range is clamped
//
// The first of those was live. `routes/cash.js` allowed a cheque status of
// 'to_deposit', which is not one of the column's values; MariaDB stored '' and
// the cheque dropped out of every status filter in the app, permanently and
// with no error anywhere. A bug that writes a row nobody can find again is
// worse than one that throws.
//
// Set per connection rather than in my.ini because the application cannot rely
// on how the server it is deployed to happens to be configured — the same
// argument as the time zone directly above.
const SESSION_SETUP = "SET time_zone = '+00:00', sql_mode = CONCAT(@@sql_mode, ',STRICT_TRANS_TABLES')";

pool.on('connection', (connection) => {
  connection.query(SESSION_SETUP, (err) => {
    if (err) {
      console.error(
        '[DB] could not set the session time zone and SQL mode:',
        err.sqlMessage || err.message
      );
      console.error('[DB] destroying this connection rather than writing shifted or coerced data.');
      connection.destroy();
    }
  });
});

// Without a listener, a pool-level error (a dropped connection, a failed
// handshake) is an unhandled event that takes the process down.
pool.on('error', (err) => {
  console.error('[DB] pool error:', err.sqlMessage || err.message);
});

module.exports = pool;
