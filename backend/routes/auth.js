/**
 * Authentication routes.
 *
 *   POST /api/auth/login   { id, password }  -> { token, user }
 *   GET  /api/auth/me                        -> { user }
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { authenticate, signToken, USER_FIELDS, TOKEN_TTL } = require('../middleware/auth');
const { checkPassword } = require('../utils/password');

const router = express.Router();

// Compared against when the id does not exist, so a missing account and a wrong
// password take the same time. Without it, the response time alone tells an
// attacker which employee ids are real.
const DUMMY_HASH = bcrypt.hashSync('password-that-is-never-valid', 10);

// Minimal in-process brute-force brake: no dependency, no shared state. It
// survives neither a restart nor a second instance, so it is a speed bump
// rather than a control — a real limiter backed by Redis is still needed
// before this is exposed beyond the LAN.
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map();

function throttle(key) {
  const now = Date.now();
  const rec = attempts.get(key);

  if (!rec || now - rec.first > WINDOW_MS) {
    attempts.set(key, { count: 1, first: now });
    return { blocked: false };
  }

  rec.count++;
  if (rec.count > MAX_ATTEMPTS) {
    return { blocked: true, retryAfter: Math.ceil((rec.first + WINDOW_MS - now) / 1000) };
  }
  return { blocked: false };
}

function clearThrottle(key) {
  attempts.delete(key);
}

// Bounded so a long-running process cannot accumulate an entry per attempted id.
setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [key, rec] of attempts) if (rec.first < cutoff) attempts.delete(key);
}, WINDOW_MS).unref();

router.post('/login', async (req, res) => {
  const { id, password } = req.body || {};

  if (typeof id !== 'string' || typeof password !== 'string' || !id || !password) {
    return res.status(400).json({ error: 'Employee ID and password are required' });
  }

  const gate = throttle(id.trim().toLowerCase());
  if (gate.blocked) {
    res.set('Retry-After', String(gate.retryAfter));
    return res.status(429).json({
      error: 'Too many sign-in attempts. Try again later.',
      retryAfter: gate.retryAfter,
    });
  }

  const [rows] = await pool.query(
    `SELECT ${USER_FIELDS}, password FROM users WHERE id = ?`,
    [id.trim()]
  );
  const user = rows[0];

  // Always run a comparison, even with no user, to keep the timing flat.
  const matches = await bcrypt.compare(password, user ? user.password : DUMMY_HASH);

  // One message for every failure mode. Distinguishing "no such user" from
  // "wrong password" hands out a list of valid employee ids for free, and
  // distinguishing "deactivated" confirms an id was once real.
  if (!user || !matches || !user.is_active) {
    return res.status(401).json({ error: 'Invalid employee ID or password' });
  }

  clearThrottle(id.trim().toLowerCase());

  delete user.password;

  // The token is issued either way — the account has to authenticate before it
  // can change anything, including its own password. `user.must_change_password`
  // rides along in USER_FIELDS and is what sends the client straight to the
  // change screen rather than letting it find out by collecting a 403 from
  // whatever it opened first. Not repeated at the top level: two fields saying
  // the same thing is two fields that can disagree.
  res.json({ token: signToken(user), expiresIn: TOKEN_TTL, user });
});

// Lets a client holding a stored token confirm it is still good, and refresh
// the profile, without a second login.
router.get('/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});

router.patch('/change-password', authenticate, async (req, res) => {
  const { current_password, new_password } = req.body || {};

  // One policy, shared with create-admin.js and POST /api/users. This route
  // used to accept six characters while the others demanded eight, so the
  // easiest way to weaken an account was to change its password.
  const policyError = checkPassword(new_password);
  if (!current_password || policyError) {
    return res.status(400).json({ error: policyError || 'Your current password is required' });
  }
  if (current_password === new_password) {
    return res.status(400).json({ error: 'The new password must be different from the current one' });
  }

  const [[account]] = await pool.query('SELECT password FROM users WHERE id = ?', [req.user.id]);
  if (!account || !(await bcrypt.compare(current_password, account.password))) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }

  // Clearing `must_change_password` is what lifts the middleware gate, and it
  // happens in the same statement as the new hash — two statements would leave
  // a window where the password is the person's but the account is still
  // locked to this one route.
  await pool.query(
    `UPDATE users
        SET password = ?, must_change_password = FALSE, password_changed_at = UTC_TIMESTAMP()
      WHERE id = ?`,
    [await bcrypt.hash(new_password, 10), req.user.id]);

  res.json({ message: 'Password changed' });
});

module.exports = router;
