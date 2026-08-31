const express = require('express');
const pool = require('../config/db');
const { authenticate, requirePermission } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { businessDay, requestedDay } = require('../utils/businessDay');

const router = express.Router();

router.use(authenticate);

// Reading where someone has been is the same act whether it is done on the map
// or in the audit report, so both take the same grant.
const requireLiveTracking = requirePermission('live_tracking.view');

router.get('/live', requireLiveTracking, async (req, res) => {
  const date = requestedDay(req.query.date);
  const [rows] = await pool.query(
    `SELECT u.id, u.name, u.phone, u.is_active, l.latitude, l.longitude, l.recorded_at,
            c.checkin_time, c.checkout_time, c.checkin_lat, c.checkin_lng
       FROM users u
       LEFT JOIN location_logs l ON l.id = (
         SELECT ll.id FROM location_logs ll
         WHERE ll.user_id = u.id AND ll.recorded_at >= ? AND ll.recorded_at < DATE_ADD(?, INTERVAL 1 DAY)
         ORDER BY ll.recorded_at DESC LIMIT 1
       )
       LEFT JOIN checkins c ON c.employee_id = u.id AND c.checkin_date = ?
      -- Deactivated accounts are off the map. They were still listed here while
      -- being excluded from every attendance view, so the two disagreed about
      -- who the workforce was — and someone offboarded stayed on the map.
      WHERE u.role = 'employee' AND u.is_active = TRUE
      ORDER BY (c.checkin_time IS NOT NULL AND c.checkout_time IS NULL) DESC, u.name ASC`,
    [date, date, date]
  );
  res.json({ locations: rows, date });
});

router.get('/user/:id/history', requireLiveTracking, async (req, res) => {
  const date = requestedDay(req.query.date);
  const [rows] = await pool.query(
    `SELECT id, latitude, longitude, recorded_at FROM location_logs
      WHERE user_id = ? AND recorded_at >= ? AND recorded_at < DATE_ADD(?, INTERVAL 1 DAY)
      ORDER BY recorded_at ASC`, [req.params.id, date, date]
  );
  res.json({ userId: req.params.id, date, locations: rows });
});

router.get('/user/:id/checkin', requireLiveTracking, async (req, res) => {
  const date = requestedDay(req.query.date);
  const [[row]] = await pool.query('SELECT * FROM checkins WHERE employee_id = ? AND checkin_date = ?', [req.params.id, date]);
  res.json(row || null);
});

/**
 * POST /location/log — where the background task sends its pings.
 *
 * Two rules that were not here before, both of which the tracking policy has
 * always claimed: a ping is only accepted while the sender is on shift, and
 * only at a rate a real device produces.
 *
 * Tracking is meant to run between check-in and check-out, pausing over lunch.
 * Previously any authenticated token could write to location_logs at any hour,
 * on any day, without limit — into the one table with no natural ceiling, and
 * the only table whose contents are a person's movements.
 */
router.post(
  '/log',
  rateLimit({ max: 20, windowMs: 60_000, message: 'Location pings are coming in too fast.' }),
  async (req, res, next) => {
    try {
      const latitude = Number(req.body?.latitude);
      const longitude = Number(req.body?.longitude);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return res.status(400).json({ error: 'A valid latitude and longitude are required' });
      }
      if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
        return res.status(400).json({ error: 'Coordinates are out of range' });
      }

      const [[shift]] = await pool.query(
        `SELECT lunch_out_time, lunch_in_time FROM checkins
          WHERE employee_id = ? AND checkin_date = ? AND checkout_time IS NULL`,
        [req.user.id, businessDay()]
      );

      if (!shift) {
        // 409 rather than 403: nothing is wrong with the caller's rights, the
        // shift is simply not open. The client uses this to stop the task.
        return res.status(409).json({ error: 'Not currently checked in', code: 'NOT_ON_SHIFT' });
      }
      if (shift.lunch_out_time && !shift.lunch_in_time) {
        return res.status(409).json({ error: 'On a lunch break', code: 'ON_BREAK' });
      }

      await pool.query(
        `INSERT INTO location_logs (user_id, latitude, longitude, recorded_at) VALUES (?, ?, ?, NOW())`,
        [req.user.id, latitude, longitude]
      );
      res.status(201).json({ success: true });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
