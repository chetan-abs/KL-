/**
 * Dispatch and delivery — Ajit builds the sheet (R03), Kamal drives it.
 *
 *   GET  /api/dispatch/sheets            sheets for a day
 *   POST /api/dispatch/sheets            open a sheet for a driver
 *   POST /api/dispatch/sheets/:id/stops  put an invoiced order on it
 *   POST /api/dispatch/sheets/:id/release   sign it off; the route goes live
 *   GET  /api/dispatch/route             the driver's own run
 *   POST /api/dispatch/stops/:id/active  "I am going here next"
 *   POST /api/dispatch/orders/:id/deliver    delivered, with proof (R06)
 *   POST /api/dispatch/orders/:id/fail       undelivered, with a reason
 */
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authenticate, requirePermission } = require('../middleware/auth');
const { numericId } = require('../middleware/params');
const { transition, notify, usersWithGrant } = require('../utils/workflow');
const { businessDay, businessTime, requestedDay } = require('../utils/businessDay');
const { userCan } = require('../utils/permissions');

router.use(authenticate);

// Rejects a non-numeric :id before any handler binds it into SQL.
numericId(router);

// GET /api/dispatch/sheets?date=YYYY-MM-DD
router.get('/sheets', requirePermission('dispatch.view'), async (req, res, next) => {
  try {
    const day = requestedDay(req.query.date) || businessDay();

    const [sheets] = await pool.query(
      `SELECT s.*, u.name AS driver_name,
              COUNT(st.id) AS stop_count,
              COALESCE(SUM(st.cartons), 0) AS carton_count
         FROM dispatch_sheets s
         JOIN users u ON u.id = s.driver_id
         LEFT JOIN dispatch_stops st ON st.sheet_id = s.id
        WHERE s.sheet_date = ?
        GROUP BY s.id, u.name
        ORDER BY u.name`,
      [day]
    );

    // Stops come back in delivery order, and each carries its loading position.
    //
    // Section 4.6: "The application supports reverse-loading logic. The stop
    // that will be delivered last should be loaded first onto the vehicle. Ajit
    // arranges the stop sequence; the application indicates the recommended
    // loading order."
    //
    // Computed here rather than left to the screen to reverse. The document
    // says the *application* indicates it, and two clients reversing a list
    // independently is two chances to get it backwards — which on a loaded van
    // means unloading everything at the first stop.
    for (const sheet of sheets) {
      const [stops] = await pool.query(
        `SELECT st.*, c.name AS party, c.city AS area, o.order_id, o.so_number,
                o.delivered_to, o.special_instructions, o.urgency
           FROM dispatch_stops st
           JOIN orders o    ON o.order_id = st.order_id
           JOIN customers c ON c.masterid = o.customer_id
          WHERE st.sheet_id = ?
          ORDER BY st.seq, st.id`,
        [sheet.id]
      );

      sheet.stops = stops.map((stop, index) => ({
        ...stop,
        delivery_seq: index + 1,
        // Last delivered, first loaded.
        load_seq: stops.length - index,
      }));

      // The loader's own view of the same list, in the order the van is packed.
      sheet.loading_order = [...sheet.stops]
        .sort((a, b) => a.load_seq - b.load_seq)
        .map((st) => ({
          load_seq: st.load_seq,
          delivery_seq: st.delivery_seq,
          party: st.party,
          area: st.area,
          cartons: st.cartons,
          so_number: st.so_number,
        }));
    }

    res.json({ date: day, sheets });
  } catch (err) {
    next(err);
  }
});

// POST /api/dispatch/sheets
/**
 * POST /api/dispatch/sheets — R-03.
 *
 * "The option to create a dispatch sheet appears only on Ajit's account. No
 *  other user sees this function."
 *
 * `dispatch.build` is that grant and Ajit is the only account holding it —
 * asserted by tests/invariants-test.js, because "only Ajit" is a fact about the
 * grant table that a route guard cannot enforce on its own.
 */
router.post('/sheets', requirePermission('dispatch.build'), async (req, res, next) => {
  const { driver_id, zone, departure_time, date } = req.body || {};
  if (!driver_id) return res.status(400).json({ error: 'driver_id is required' });

  try {
    const day = requestedDay(date) || businessDay();
    const [result] = await pool.query(
      `INSERT INTO dispatch_sheets (sheet_date, driver_id, zone, departure_time)
       VALUES (?, ?, ?, ?)`,
      [day, driver_id, zone || null, departure_time || null]
    );
    res.status(201).json({ message: 'Sheet opened', sheet_id: result.insertId, date: day });
  } catch (err) {
    // One sheet per driver per day. Two would split the run and neither would
    // show the whole load.
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'That driver already has a sheet for the day' });
    }
    if (err.code === 'ER_NO_REFERENCED_ROW_2') {
      return res.status(400).json({ error: 'No such driver' });
    }
    next(err);
  }
});

// POST /api/dispatch/sheets/:id/stops
router.post('/sheets/:id/stops', requirePermission('dispatch.build'), async (req, res, next) => {
  const sheetId = Number(req.params.id);
  const orderId = Number(req.body?.order_id);

  if (!Number.isInteger(sheetId) || !Number.isInteger(orderId)) {
    return res.status(400).json({ error: 'sheet id and order_id are required' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[sheet]] = await conn.query(
      'SELECT id, status FROM dispatch_sheets WHERE id = ? FOR UPDATE',
      [sheetId]
    );
    if (!sheet) {
      await conn.rollback();
      return res.status(404).json({ error: 'No such sheet' });
    }
    if (sheet.status !== 'building') {
      await conn.rollback();
      return res.status(409).json({ error: 'That sheet is already released' });
    }

    const [[order]] = await conn.query('SELECT status FROM orders WHERE order_id = ?', [orderId]);
    if (!order) {
      await conn.rollback();
      return res.status(404).json({ error: 'No such order' });
    }
    // Goods leave the building only once they are billed.
    if (order.status !== 'invoiced') {
      await conn.rollback();
      return res.status(409).json({
        error: `Only an invoiced order can be loaded. This one is ${order.status}.`,
      });
    }

    const [[last]] = await conn.query(
      'SELECT COALESCE(MAX(seq), 0) AS seq FROM dispatch_stops WHERE sheet_id = ?',
      [sheetId]
    );

    await conn.query(
      `INSERT INTO dispatch_stops (sheet_id, order_id, seq, cartons, is_urgent, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        sheetId,
        orderId,
        last.seq + 1,
        Math.max(1, Number(req.body?.cartons) || 1),
        Boolean(req.body?.is_urgent),
        req.body?.note || null,
      ]
    );

    await conn.commit();
    res.status(201).json({ message: 'Stop added', seq: last.seq + 1 });
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'That order is already on a sheet' });
    }
    next(err);
  } finally {
    conn.release();
  }
});

// POST /api/dispatch/sheets/:id/release
router.post('/sheets/:id/release', requirePermission('dispatch.build'), async (req, res, next) => {
  const sheetId = Number(req.params.id);
  // Checked before it reaches SQL: mysql2 renders a bound NaN as the bare token
  // NaN, so an unparseable id came back as "Unknown column 'NaN' in 'where
  // clause'" — a 500 describing our schema, for what is a bad request.
  if (!Number.isInteger(sheetId)) return res.status(400).json({ error: 'Invalid sheet id' });

  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const [result] = await conn.query(
      `UPDATE dispatch_sheets SET status = 'released', released_by = ?, released_at = NOW()
        WHERE id = ? AND status = 'building'`,
      [req.user.id, sheetId]
    );

    if (!result.affectedRows) {
      await conn.rollback();
      return res.status(409).json({ error: 'That sheet is not open for release' });
    }

    const [stops] = await conn.query(
      'SELECT order_id FROM dispatch_stops WHERE sheet_id = ?',
      [sheetId]
    );

    if (!stops.length) {
      await conn.rollback();
      return res.status(409).json({ error: 'An empty sheet cannot be released' });
    }

    for (const stop of stops) {
      const moved = await transition(conn, {
        orderId: stop.order_id,
        to: 'dispatched',
        expectedFrom: 'invoiced',
        userId: req.user.id,
        note: `Released on sheet ${sheetId}`,
      });
      if (!moved.ok) {
        await conn.rollback();
        return res.status(409).json({
          error: `Order ${stop.order_id}: ${moved.message}`,
          code: moved.reason,
        });
      }
    }

    const [[sheet]] = await conn.query('SELECT driver_id FROM dispatch_sheets WHERE id = ?', [sheetId]);
    await notify(conn, {
      userId: sheet.driver_id,
      tone: 'info',
      title: 'Route released',
      body: `${stops.length} stop(s) on today's run.`,
      actor: req.user.name,
      refType: 'sheet',
      refId: sheetId,
    });

    await conn.commit();
    res.json({ message: 'Sheet released', stops: stops.length });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// GET /api/dispatch/route — the caller's own run
//
// Ungated beyond authenticate, like the caller's own shift actions: this is the
// driver's own sheet, scoped to them by the query rather than by a grant.
/**
 * POST /api/dispatch/sheets/:id/sign — the driver's acknowledgement (4.6).
 *
 * "Both drivers provide a digital signature on the dispatch sheet."
 *
 * Signed by the driver, on their own sheet, and scoped to `req.user.id` for
 * that reason — Ajit builds the sheet and cannot sign for the man taking it
 * out. As with Ajit's verification, what carries the weight is the
 * authenticated account and the timestamp; the drawn image is optional.
 */
router.post('/sheets/:id/sign', async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[sheet]] = await conn.query(
      'SELECT * FROM dispatch_sheets WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!sheet) {
      await conn.rollback();
      return res.status(404).json({ error: 'No such sheet' });
    }
    // The driver signs for their own run. Nobody signs on their behalf.
    if (sheet.driver_id !== req.user.id) {
      await conn.rollback();
      return res.status(403).json({
        error: 'A dispatch sheet is signed by the driver taking it out.',
        code: 'NOT_YOUR_SHEET',
      });
    }
    if (sheet.status === 'building') {
      await conn.rollback();
      return res.status(409).json({
        error: 'That sheet has not been released yet.', code: 'NOT_RELEASED' });
    }

    await conn.query(
      'UPDATE dispatch_sheets SET driver_signed_at = NOW(), driver_sign_id = ? WHERE id = ?',
      [req.body?.signature_id ? Number(req.body.signature_id) : null, sheet.id]);

    await conn.commit();
    res.json({ message: 'Sheet signed.' });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

/**
 * POST /api/dispatch/sheets/:id/depart — log the departure (4.6).
 *
 * "Departure time is expected at 10:30 a.m. If drivers have not departed by
 *  this time, Yash receives an automatic notification."
 *
 * The alert half of that lives in utils/alerts.js and fires on the ABSENCE of
 * this row. So this route is what stops the alert, which is why the driver can
 * call it themselves: an alert that only Ajit can silence would fire every day
 * he was away from his desk at 10:30.
 */
router.post('/sheets/:id/depart', async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[sheet]] = await conn.query(
      'SELECT * FROM dispatch_sheets WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!sheet) {
      await conn.rollback();
      return res.status(404).json({ error: 'No such sheet' });
    }
    // The driver on the run, or whoever builds the sheets.
    if (sheet.driver_id !== req.user.id && !userCan(req.user, 'dispatch.build')) {
      await conn.rollback();
      return res.status(403).json({ error: 'That is not your run.', code: 'NOT_YOUR_SHEET' });
    }
    if (sheet.status === 'building') {
      await conn.rollback();
      return res.status(409).json({
        error: 'Release the sheet before the van leaves.', code: 'NOT_RELEASED' });
    }
    if (sheet.departure_time) {
      await conn.rollback();
      return res.status(409).json({
        error: `Departure was already logged at ${sheet.departure_time}.`, code: 'ALREADY_DEPARTED' });
    }

    // The wall-clock time in the business timezone, not a UTC one: the 10:30
    // deadline is a time in Guwahati, and the column is a TIME.
    const at = businessTime();
    await conn.query(
      'UPDATE dispatch_sheets SET departure_time = ? WHERE id = ?', [at, sheet.id]);

    const late = at > String(sheet.expected_departure || '10:30:00');
    if (late) {
      for (const owner of await usersWithGrant(conn, 'all')) {
        await notify(conn, {
          userId: owner,
          tone: 'warning',
          title: 'Van departed late',
          body: `${sheet.zone || 'Route'} left at ${at}, expected ${sheet.expected_departure}.`,
          actor: req.user.id,
          refType: 'dispatch_sheet',
          refId: sheet.id,
        });
      }
    }

    await conn.commit();
    res.json({ message: `Departure logged at ${at}.`, departure_time: at, late });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

router.get('/route', async (req, res, next) => {
  try {
    const day = requestedDay(req.query.date) || businessDay();

    const [[sheet]] = await pool.query(
      `SELECT * FROM dispatch_sheets
        WHERE driver_id = ? AND sheet_date = ? AND status = 'released'`,
      [req.user.id, day]
    );

    if (!sheet) return res.json({ sheet: null, stops: [] });

    const [stops] = await pool.query(
      `SELECT st.*, c.name AS party, c.city AS area, c.address,
              o.notes AS instructions,
              d.status AS delivery_status, d.delivered_at, d.received_by
         FROM dispatch_stops st
         JOIN orders o    ON o.order_id = st.order_id
         JOIN customers c ON c.masterid = o.customer_id
         LEFT JOIN deliveries d ON d.order_id = st.order_id
        WHERE st.sheet_id = ?
        ORDER BY st.state = 'done', st.is_urgent DESC, st.seq`,
      [sheet.id]
    );

    res.json({ sheet, stops });
  } catch (err) {
    next(err);
  }
});

// POST /api/dispatch/stops/:id/active — the driver reorders as they go
router.post('/stops/:id/active', async (req, res, next) => {
  try {
    // Scoped to the caller's own sheet: a driver may reorder their run, not
    // somebody else's.
    const [result] = await pool.query(
      `UPDATE dispatch_stops st
         JOIN dispatch_sheets s ON s.id = st.sheet_id
          SET st.state = 'active'
        WHERE st.id = ? AND s.driver_id = ? AND st.state = 'pending'`,
      [Number(req.params.id), req.user.id]
    );

    if (!result.affectedRows) {
      return res.status(404).json({ error: 'No such stop on your sheet' });
    }
    res.json({ message: 'Stop is now active' });
  } catch (err) {
    next(err);
  }
});

// POST /api/dispatch/orders/:id/deliver — R06
router.post('/orders/:id/deliver', async (req, res, next) => {
  const orderId = Number(req.params.id);
  const { received_by, photo_ref, latitude, longitude } = req.body || {};

  // Both are mandatory, and both are checked here rather than only in the UI.
  // A delivery with nobody's name against it proves nothing, and the photo is
  // the proof — there is deliberately no party signature.
  if (!String(received_by || '').trim()) {
    return res.status(400).json({ error: 'The name of whoever received the goods is required' });
  }
  if (!String(photo_ref || '').trim()) {
    return res.status(400).json({ error: 'A delivery photo is required', code: 'PHOTO_REQUIRED' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // The driver may only close their own stop.
    const [[stop]] = await conn.query(
      `SELECT st.id FROM dispatch_stops st
         JOIN dispatch_sheets s ON s.id = st.sheet_id
        WHERE st.order_id = ? AND s.driver_id = ?`,
      [orderId, req.user.id]
    );
    if (!stop) {
      await conn.rollback();
      return res.status(404).json({ error: 'That order is not on your sheet' });
    }

    const moved = await transition(conn, {
      orderId,
      to: 'delivered',
      expectedFrom: 'dispatched',
      userId: req.user.id,
      note: `Received by ${String(received_by).trim()}`,
    });

    if (!moved.ok) {
      await conn.rollback();
      return res.status(409).json({ error: moved.message, code: moved.reason });
    }

    await conn.query(
      `INSERT INTO deliveries (order_id, status, received_by, photo_ref, latitude, longitude, delivered_by)
       VALUES (?, 'delivered', ?, ?, ?, ?, ?)`,
      [
        orderId,
        String(received_by).trim(),
        String(photo_ref).trim(),
        latitude ?? null,
        longitude ?? null,
        req.user.id,
      ]
    );

    await conn.query("UPDATE dispatch_stops SET state = 'done' WHERE id = ?", [stop.id]);

    await conn.commit();
    res.json({ message: 'Delivered', order_id: orderId });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// POST /api/dispatch/orders/:id/fail — a real outcome, not a missing row
router.post('/orders/:id/fail', async (req, res, next) => {
  const orderId = Number(req.params.id);
  const reason = String(req.body?.reason || '').trim();

  if (!reason) return res.status(400).json({ error: 'An undelivered stop needs a reason' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[stop]] = await conn.query(
      `SELECT st.id FROM dispatch_stops st
         JOIN dispatch_sheets s ON s.id = st.sheet_id
        WHERE st.order_id = ? AND s.driver_id = ?`,
      [orderId, req.user.id]
    );
    if (!stop) {
      await conn.rollback();
      return res.status(404).json({ error: 'That order is not on your sheet' });
    }

    const moved = await transition(conn, {
      orderId,
      to: 'undelivered',
      expectedFrom: 'dispatched',
      userId: req.user.id,
      note: reason,
    });

    if (!moved.ok) {
      await conn.rollback();
      return res.status(409).json({ error: moved.message, code: moved.reason });
    }

    await conn.query(
      `INSERT INTO deliveries (order_id, status, reason, photo_ref, delivered_by)
       VALUES (?, 'undelivered', ?, ?, ?)`,
      [orderId, reason, req.body?.photo_ref || null, req.user.id]
    );

    await conn.query("UPDATE dispatch_stops SET state = 'failed' WHERE id = ?", [stop.id]);

    for (const dispatcherId of await usersWithGrant(conn, 'dispatch')) {
      await notify(conn, {
        userId: dispatcherId,
        tone: 'warning',
        title: 'Delivery failed',
        body: `Order ${orderId} — ${reason}. It needs re-scheduling.`,
        actor: req.user.name,
        refType: 'order',
        refId: orderId,
      });
    }

    await conn.commit();
    res.json({ message: 'Recorded as undelivered', order_id: orderId });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
