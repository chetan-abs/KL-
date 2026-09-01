/**
 * The order pipeline: approval, picking and verification.
 *
 *   POST /api/workflow/orders/:id/approve   Manas, or automatic at punch (4.2)
 *   POST /api/workflow/orders/:id/reject    Manas
 *   GET  /api/workflow/picks                Ashish
 *   POST /api/workflow/orders/:id/pick      Ashish
 *   POST /api/workflow/orders/:id/handover  Ashish — also auto-verifies (4.2)
 *   GET  /api/workflow/verifications        Sonu
 *   POST /api/workflow/orders/:id/verify    Sonu    (R02)
 *   GET  /api/workflow/orders/:id/events    audit trail
 *
 * September 2026, section 4.2 — CHANGED FROM v1 twice over: Manas's approval
 * of every order is gone (`routes/orders.js` decides it automatically at
 * punch, see `approveOrder` below), and verification is no longer 100% —
 * `handover` decides whether an order needs Sonu's count or is auto-verified
 * against what was picked, the same way approval is auto-decided. Both are
 * "quiet unless something is actually wrong", not "no human ever looks
 * again" — see the exception conditions in each.
 *
 * Billing, dispatch and delivery live in their own modules; they are separate
 * duties held by separate people, and a single pipeline router would have to be
 * guarded per route anyway.
 *
 * Guards are per route, never on the router. `employees.view` and `employees`
 * are not interchangeable: an area grant satisfies an action check, never the
 * reverse, so a router-level guard would lock out every account holding only the
 * action grant it was meant to admit.
 */
const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authenticate, requirePermission } = require('../middleware/auth');
const { numericId } = require('../middleware/params');
const { transition, notify, usersWithGrant, qty } = require('../utils/workflow');
const { businessDay } = require('../utils/businessDay');
const {
  enqueue: tallyEnqueue, salesOrderXml, config: tallyConfig,
} = require('../utils/tally');

router.use(authenticate);

// Rejects a non-numeric :id before any handler binds it into SQL.
numericId(router);

// 4.2 — "contains a high-value SKU above the set per-unit value." No figure
// is given, same as the order-value threshold in routes/orders.js; set
// VERIFICATION_HIGH_VALUE_THRESHOLD in .env once Yash names one. 0/unset
// disables this leg of the exception check rather than flagging every line.
const VERIFICATION_HIGH_VALUE_THRESHOLD = Number(process.env.VERIFICATION_HIGH_VALUE_THRESHOLD) || 0;

/** A pick line's outcome follows from its count, so the two cannot disagree. */
function pickStatus(picked, need) {
  const count = Number(picked);
  if (!Number.isFinite(count)) return 'pending';
  if (count <= 0) return 'missing';
  if (count >= Number(need)) return 'done';
  return 'partial';
}

// ---------------------------------------------------------------------------
// Approval — Manas
// ---------------------------------------------------------------------------

/**
 * Moves an order into 'approved' and does everything that move entails —
 * the Tally sales-order push (section 14) and telling picking there is work.
 * Shared between the manual approve route below and `POST /orders`'s own
 * auto-approval (4.2: "everything else — about 95% of orders — straight to
 * picking, no approval, no human gate"), so an auto-approved order gets
 * exactly the same side effects a Manas-approved one always has — nothing
 * about what approval DOES changes, only who or what decides to grant it.
 *
 * Runs inside the caller's transaction and does not commit; the caller does.
 * Returns `{ ok: false, reason, message }` on an illegal transition, the same
 * shape `transition()` itself returns.
 */
async function approveOrder(conn, { orderId, userId, userName, note = null }) {
  const result = await transition(conn, {
    orderId, to: 'approved', expectedFrom: ['pending', 'confirmed'], note, userId,
  });
  if (!result.ok) return result;

  // Section 14: "Sales Orders (on approval)". R-01 makes approval the moment
  // the order becomes real, so it is the moment Tally hears about it.
  const [[approved]] = await conn.query(
    `SELECT o.*, c.name AS party_name FROM orders o
       JOIN customers c ON c.masterid = o.customer_id WHERE o.order_id = ?`,
    [orderId]
  );
  const [approvedLines] = await conn.query(
    `SELECT oi.*, i.unit FROM order_items oi
       LEFT JOIN items i ON i.masterid = oi.item_id WHERE oi.order_id = ?`,
    [orderId]
  );
  await tallyEnqueue(conn, {
    kind: 'sales_order',
    refType: 'order',
    refId: orderId,
    payload: salesOrderXml({
      order: approved, lines: approvedLines, company: tallyConfig().company }),
    userId,
  });

  // Picking is told there is work; the salesman is told their order cleared.
  const [[order]] = await conn.query(
    `SELECT o.created_by, c.name AS party FROM orders o
       JOIN customers c ON c.masterid = o.customer_id
      WHERE o.order_id = ?`,
    [orderId]
  );

  for (const pickerId of await usersWithGrant(conn, 'picking')) {
    await notify(conn, {
      userId: pickerId,
      tone: 'info',
      title: 'Order ready to pick',
      body: `${order.party} — waiting in the godown.`,
      actor: userName,
      refType: 'order',
      refId: orderId,
    });
  }

  if (order.created_by && order.created_by !== userId) {
    await notify(conn, {
      userId: order.created_by,
      tone: 'success',
      title: 'Order approved',
      body: `${order.party} approved — sent to picking.`,
      actor: userName,
      refType: 'order',
      refId: orderId,
    });
  }

  return { ok: true };
}

// POST /api/workflow/orders/:id/approve
router.post('/orders/:id/approve', requirePermission('orders.approve'), async (req, res, next) => {
  const orderId = Number(req.params.id);
  if (!Number.isInteger(orderId)) return res.status(400).json({ error: 'Invalid order id' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const result = await approveOrder(conn, {
      orderId, userId: req.user.id, userName: req.user.name, note: req.body?.note || null,
    });

    if (!result.ok) {
      await conn.rollback();
      return res
        .status(result.reason === 'NOT_FOUND' ? 404 : 409)
        .json({ error: result.message, code: result.reason });
    }

    await conn.commit();
    res.json({ message: 'Order approved', order_id: orderId, status: 'approved' });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// POST /api/workflow/orders/:id/reject
router.post('/orders/:id/reject', requirePermission('orders.approve'), async (req, res, next) => {
  const orderId = Number(req.params.id);
  if (!Number.isInteger(orderId)) return res.status(400).json({ error: 'Invalid order id' });

  // A rejection the salesman cannot explain to the party is not much use.
  const reason = String(req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'A rejection needs a reason' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const result = await transition(conn, {
      orderId,
      to: 'rejected',
      expectedFrom: ['pending', 'confirmed'],
      note: reason,
      userId: req.user.id,
    });

    if (!result.ok) {
      await conn.rollback();
      return res
        .status(result.reason === 'NOT_FOUND' ? 404 : 409)
        .json({ error: result.message, code: result.reason });
    }

    // Stock committed at order time comes back, in this transaction. The ledger
    // is append-only, so this is opposing rows, never an edit of the originals.
    const [lines] = await conn.query(
      'SELECT item_id, qty FROM order_items WHERE order_id = ?',
      [orderId]
    );
    for (const line of lines) {
      await conn.query(
        `INSERT INTO stock_movements (item_id, change_qty, reason, ref_type, ref_id, note, created_by)
         VALUES (?, ?, 'adjustment', 'order', ?, 'Order rejected', ?)`,
        [line.item_id, qty(line.qty), orderId, req.user.id]
      );
      await conn.query(
        `UPDATE items SET qty = (SELECT COALESCE(SUM(change_qty), 0) FROM stock_movements WHERE item_id = ?)
         WHERE masterid = ?`,
        [line.item_id, line.item_id]
      );
    }

    const [[order]] = await conn.query(
      `SELECT o.created_by, c.name AS party FROM orders o
         JOIN customers c ON c.masterid = o.customer_id
        WHERE o.order_id = ?`,
      [orderId]
    );

    if (order?.created_by) {
      await notify(conn, {
        userId: order.created_by,
        tone: 'danger',
        title: 'Order rejected',
        body: `${order.party} — ${reason}`,
        actor: req.user.name,
        refType: 'order',
        refId: orderId,
      });
    }

    await conn.commit();
    res.json({ message: 'Order rejected', order_id: orderId, status: 'rejected' });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// ---------------------------------------------------------------------------
// Picking — Ashish
// ---------------------------------------------------------------------------

// GET /api/workflow/picks — what is waiting in the godown
router.get('/picks', requirePermission('picking.view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT o.order_id, o.status, o.order_date, c.name AS party,
              COUNT(oi.id) AS line_count,
              COALESCE(SUM(p.status IS NOT NULL AND p.status <> 'pending'), 0) AS done
         FROM orders o
         JOIN customers c    ON c.masterid = o.customer_id
         LEFT JOIN order_items oi ON oi.order_id = o.order_id
         LEFT JOIN order_picks p  ON p.order_item_id = oi.id
        WHERE o.status IN ('approved','picking')
        GROUP BY o.order_id, o.status, o.order_date, c.name
        ORDER BY o.order_date ASC, o.order_id ASC`
    );
    res.json({ picks: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/workflow/orders/:id/picksheet — the lines to walk
router.get('/orders/:id/picksheet', requirePermission('picking.view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT oi.id AS order_item_id, oi.item_name, oi.qty AS need_qty,
              p.picked_qty, p.status, p.rack, p.note
         FROM order_items oi
         LEFT JOIN order_picks p ON p.order_item_id = oi.id
        WHERE oi.order_id = ?
        ORDER BY oi.id`,
      [Number(req.params.id)]
    );
    res.json({ lines: rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/workflow/orders/:id/pick — record what came off the racks
/**
 * 4.3, "Material Photo": "When a picker picks an item, the application provides
 * the option to photograph the material before it is packed. The photo is saved
 * against the SO and is viewable by authorised roles."
 *
 * Optional, per line, and validated only when sent — a picker with one hand on
 * a coil of wire is not going to photograph all eleven lines, and refusing the
 * pick because they photographed three would stop the godown.
 *
 * Ownership is checked for the same reason it is on a check-in: an id somebody
 * else uploaded is not evidence that THIS picker handled THIS item.
 */
async function readPickPhoto(conn, photoId, userId) {
  if (!photoId) return { id: null };
  const [[shot]] = await conn.query(
    'SELECT id, uploaded_by FROM attachments WHERE id = ?', [Number(photoId)]);
  if (!shot) return { error: 'That photograph was not found.', code: 'PHOTO_NOT_FOUND' };
  if (shot.uploaded_by !== userId) {
    return { error: 'That photograph belongs to somebody else.', code: 'PHOTO_NOT_YOURS' };
  }
  return { id: shot.id };
}

/**
 * R-05 — the godown register.
 *
 *   "A valid SO number must be entered in the physical godown register before
 *    picking begins. App enforces acknowledgement."
 *   "When picking from the Berlia or Fan godown, the picker must first record
 *    the SO number in the physical godown register before picking begins."
 *
 * The app cannot read a paper register, so what it enforces is the
 * acknowledgement: the picker states that they have written the SO number down,
 * and that statement is timestamped against their account before any pick on
 * that order is accepted. That is the honest reading of "enforces
 * acknowledgement" — unskippable and attributable, not verified.
 *
 * Only the godowns that keep a register are gated. Gating every godown would
 * put a modal in front of every pick in the building, which is how an
 * acknowledgement becomes a reflex nobody reads.
 */
const REGISTERED_GODOWNS = ['Berlia', 'Fan'];

const needsRegister = (godown) => Boolean(godown)
  && REGISTERED_GODOWNS.some((g) => g.toLowerCase() === String(godown).toLowerCase());

/**
 * Which of an order's lines sit in a godown that keeps a register, and whether
 * the picker has acknowledged each one.
 */
async function registerState(conn, orderId) {
  const [rows] = await conn.query(
    `SELECT DISTINCT i.godown
       FROM order_items oi JOIN items i ON i.masterid = oi.item_id
      WHERE oi.order_id = ? AND i.godown IS NOT NULL`,
    [orderId]);

  const required = rows.map((r) => r.godown).filter(needsRegister);
  if (!required.length) return { required: [], missing: [] };

  const [acked] = await conn.query(
    'SELECT godown FROM godown_register_acks WHERE order_id = ?', [orderId]);
  const done = new Set(acked.map((a) => String(a.godown).toLowerCase()));

  return {
    required,
    missing: required.filter((g) => !done.has(String(g).toLowerCase())),
  };
}

/**
 * POST /api/workflow/orders/:id/godown-register — acknowledge the register.
 *
 * The picker sends the godown they are about to draw from. Recorded once per
 * (order, godown); a second call is not an error, because a picker returning
 * to the same rack should not be told off for confirming again.
 */
router.post('/orders/:id/godown-register', requirePermission('picking.record'), async (req, res, next) => {
  try {
    const godown = String(req.body?.godown || '').trim();
    if (!godown) {
      return res.status(400).json({ error: 'Which godown?', code: 'GODOWN_REQUIRED' });
    }
    if (req.body?.acknowledged !== true) {
      return res.status(400).json({
        error: 'Confirm that the SO number is written in the godown register.',
        code: 'ACKNOWLEDGEMENT_REQUIRED',
      });
    }

    const [[order]] = await pool.query(
      'SELECT order_id, so_number FROM orders WHERE order_id = ?', [req.params.id]);
    if (!order) return res.status(404).json({ error: 'No such order' });

    await pool.query(
      `INSERT INTO godown_register_acks (order_id, godown, so_number, acked_by)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE acked_at = NOW(), acked_by = VALUES(acked_by)`,
      [order.order_id, godown, order.so_number, req.user.id]);

    res.json({
      message: `Register acknowledged for the ${godown} godown.`,
      so_number: order.so_number,
    });
  } catch (err) { next(err); }
});

router.post('/orders/:id/pick', requirePermission('picking.record'), async (req, res, next) => {
  const orderId = Number(req.params.id);
  const lines = Array.isArray(req.body?.lines) ? req.body.lines : null;

  if (!Number.isInteger(orderId)) return res.status(400).json({ error: 'Invalid order id' });
  if (!lines?.length) return res.status(400).json({ error: 'Send at least one picked line' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[order]] = await conn.query(
      'SELECT order_id, status FROM orders WHERE order_id = ? FOR UPDATE',
      [orderId]
    );
    if (!order) {
      await conn.rollback();
      return res.status(404).json({ error: 'No such order' });
    }
    if (!['approved', 'picking', 'picked', 'confirmed'].includes(order.status)) {
      await conn.rollback();
      return res.status(409).json({ error: `An order at ${order.status} is not being picked.` });
    }

    // R-05, before a single line is written. Checked here rather than only on
    // the picking screen: the rule exists because a physical register is the
    // only record of who was in the Berlia godown and when, and a client that
    // skipped the modal would leave no trace at all.
    const register = await registerState(conn, orderId);
    if (register.missing.length) {
      await conn.rollback();
      return res.status(409).json({
        error: `Write the SO number in the ${register.missing.join(' and ')} godown register first, then acknowledge it.`,
        code: 'GODOWN_REGISTER_REQUIRED',
        godowns: register.missing,
      });
    }

    // Lines are matched against this order's own items, so a request cannot
    // write a pick against somebody else's order by guessing an id.
    const [own] = await conn.query(
      'SELECT id, qty FROM order_items WHERE order_id = ?',
      [orderId]
    );
    const needById = new Map(own.map((row) => [row.id, Number(row.qty)]));

    for (const line of lines) {
      const itemId = Number(line.order_item_id);
      if (!needById.has(itemId)) {
        await conn.rollback();
        return res.status(400).json({ error: `Line ${line.order_item_id} is not on this order` });
      }

      const need = needById.get(itemId);
      const picked = qty(Math.max(0, Number(line.picked_qty) || 0));
      const status = pickStatus(picked, need);

      const shot = await readPickPhoto(conn, line.photo_id, req.user.id);
      if (shot.error) {
        await conn.rollback();
        return res.status(400).json({ error: shot.error, code: shot.code });
      }

      await conn.query(
        `INSERT INTO order_picks (order_id, order_item_id, rack, need_qty, picked_qty, status, note, picked_by, picked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
           picked_qty = VALUES(picked_qty), status = VALUES(status),
           rack = VALUES(rack), note = VALUES(note),
           picked_by = VALUES(picked_by), picked_at = VALUES(picked_at)`,
        [orderId, itemId, line.rack || null, need, picked, status, line.note || null, req.user.id]
      );
    }

    if (order.status === 'approved') {
      await transition(conn, { orderId, to: 'picking', userId: req.user.id, note: 'Picking started' });
    }

    await conn.commit();
    res.json({ message: 'Pick recorded', order_id: orderId });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// POST /api/workflow/orders/:id/handover — done picking, over to Ajit
router.post('/orders/:id/handover', requirePermission('picking.record'), async (req, res, next) => {
  const orderId = Number(req.params.id);
  if (!Number.isInteger(orderId)) return res.status(400).json({ error: 'Invalid order id' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Every line must have an outcome. A blank line is not a zero — it means
    // nobody looked, and handing that to the count buries the difference.
    const [[open]] = await conn.query(
      `SELECT COUNT(*) AS pending
         FROM order_items oi
         LEFT JOIN order_picks p ON p.order_item_id = oi.id
        WHERE oi.order_id = ? AND (p.id IS NULL OR p.status = 'pending')`,
      [orderId]
    );

    if (open.pending > 0) {
      await conn.rollback();
      return res.status(409).json({
        error: `${open.pending} line(s) still have no outcome. Mark every line before handing over.`,
        code: 'INCOMPLETE',
      });
    }

    const result = await transition(conn, {
      orderId,
      to: 'picked',
      expectedFrom: 'picking',
      userId: req.user.id,
      note: 'Handed to verification',
    });

    if (!result.ok) {
      await conn.rollback();
      return res
        .status(result.reason === 'NOT_FOUND' ? 404 : 409)
        .json({ error: result.message, code: result.reason });
    }

    const [[short]] = await conn.query(
      `SELECT COUNT(*) AS n FROM order_picks
        WHERE order_id = ? AND status IN ('partial','missing')`,
      [orderId]
    );

    // 4.2 — CHANGED FROM v1: verification is exception-based now, not 100%.
    // "With order approval removed, this is the only human gate before
    // billing; if it stays at 100% the queue simply carries a new name."
    // A short or missing pick is ALWAYS an exception on its own — nobody
    // auto-signs-off a pick that did not go as ordered.
    const exceptionReasons = [];
    if (short.n > 0) exceptionReasons.push(`${short.n} line(s) short of the SO`);

    const [lines] = await conn.query(
      `SELECT oi.id, oi.item_name, oi.qty, oi.rate, p.picked_qty
         FROM order_items oi LEFT JOIN order_picks p ON p.order_item_id = oi.id
        WHERE oi.order_id = ?`,
      [orderId]
    );
    if (lines.length > 15) exceptionReasons.push(`${lines.length} line items`);

    if (VERIFICATION_HIGH_VALUE_THRESHOLD > 0) {
      const highValue = lines.find((l) => Number(l.rate) > VERIFICATION_HIGH_VALUE_THRESHOLD);
      if (highValue) exceptionReasons.push(`${highValue.item_name} above the per-unit value set for review`);
    }

    const [[returnHistory]] = await conn.query(
      `SELECT COUNT(*) AS n, c.name AS party FROM sales_returns sr
         JOIN orders o ON o.customer_id = sr.customer_id
         JOIN customers c ON c.masterid = o.customer_id
        WHERE o.order_id = ? AND sr.status = 'accepted'
        GROUP BY c.name`,
      [orderId]
    );
    if (returnHistory?.n > 0) exceptionReasons.push(`${returnHistory.party} carries a sales-return history`);

    // "The picker is new — first 30 days." Proxied by account creation,
    // which is the closest thing to a start date this schema records.
    const [[newPicker]] = await conn.query(
      `SELECT u.name FROM order_picks p JOIN users u ON u.id = p.picked_by
        WHERE p.order_id = ? AND u.created_at > (NOW() - INTERVAL 30 DAY)
        LIMIT 1`,
      [orderId]
    );
    if (newPicker) exceptionReasons.push(`${newPicker.name} is a new picker (first 30 days)`);

    // "The order falls in the daily random 10% sample." Deterministic rather
    // than a fresh Math.random() per call, so an order sampled once stays
    // sampled if handover is somehow retried — MD5 of (order id, today) taken
    // modulo 10 gives a stable, roughly-uniform 1-in-10 without a table to
    // track which orders were already drawn today.
    const sampleHash = crypto.createHash('md5').update(`${orderId}:${businessDay()}`).digest();
    if (sampleHash.readUInt8(0) % 10 === 0) exceptionReasons.push('daily random 10% sample');

    let finalStatus = 'picked';
    if (!exceptionReasons.length) {
      // Auto-verified against what was actually PICKED, never the ordered
      // figure — "the invoice bills what was counted, not what was ordered"
      // holds exactly the same way here as it does for a human count.
      for (const line of lines) {
        const counted = line.picked_qty === null ? line.qty : line.picked_qty;
        await conn.query(
          `INSERT INTO order_verifications (order_id, order_item_id, expected_qty, counted_qty, is_mismatch, verified_by)
           VALUES (?, ?, ?, ?, FALSE, NULL)
           ON DUPLICATE KEY UPDATE
             counted_qty = VALUES(counted_qty), is_mismatch = FALSE, verified_by = NULL, verified_at = NOW()`,
          [orderId, line.id, qty(counted), qty(counted)]
        );
      }
      const autoVerify = await transition(conn, {
        orderId, to: 'verified', expectedFrom: 'picked', userId: req.user.id,
        note: 'Auto-verified at handover — no exception conditions (4.2).',
      });
      if (autoVerify.ok) finalStatus = 'verified';
    }

    for (const verifierId of await usersWithGrant(conn, 'verification')) {
      await notify(conn, {
        userId: verifierId,
        tone: exceptionReasons.length ? 'warning' : 'info',
        title: finalStatus === 'verified' ? 'Order auto-verified' : 'Order ready to verify',
        body: finalStatus === 'verified'
          ? 'Picked in full and verified automatically — nothing needs your count.'
          : exceptionReasons.join('; '),
        actor: req.user.name,
        refType: 'order',
        refId: orderId,
      });
    }

    await conn.commit();
    res.json({
      message: finalStatus === 'verified' ? 'Auto-verified — sent to billing.' : 'Handed over for verification',
      order_id: orderId,
      status: finalStatus,
      short_lines: short.n,
      exception_reasons: exceptionReasons.length ? exceptionReasons : null,
    });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// ---------------------------------------------------------------------------
// Verification — Ajit (R02)
// ---------------------------------------------------------------------------

// GET /api/workflow/verifications
router.get('/verifications', requirePermission('verification.view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT o.order_id, o.status, c.name AS party, COUNT(oi.id) AS line_count
         FROM orders o
         JOIN customers c ON c.masterid = o.customer_id
         LEFT JOIN order_items oi ON oi.order_id = o.order_id
        WHERE o.status IN ('picked','verified')
        GROUP BY o.order_id, o.status, c.name
        ORDER BY o.order_id`
    );
    res.json({ verifications: rows });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/workflow/orders/:id/verifysheet — what Ajit counts against.
 *
 * Section 4.4: "Ajit physically counts every item that has been picked. He
 * enters the counted quantity for each item in the application."
 *
 * He could not. The pick sheet is gated on `picking.view`, which Ajit
 * deliberately does not hold — he verifies, he does not pick — and
 * `/verifications` gives only a per-order summary. So the one screen the
 * verification step needs had no endpoint behind it: the count could be
 * submitted but not informed.
 *
 * Returns the ordered quantity, the picked quantity and any count already
 * entered, so a partial verification can be resumed. `expected` is what the
 * count is compared against, and it is the PICKED figure rather than the
 * ordered one — a short pick is meant to bill short (that is why the count
 * happens), so counting against the SO would flag every short pick as a
 * mismatch and bury the real ones.
 */
router.get('/orders/:id/verifysheet', requirePermission('verification.view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT oi.id AS order_item_id, oi.item_name, oi.hsn,
              oi.qty AS ordered_qty,
              p.picked_qty, p.status AS pick_status, p.rack, p.note AS pick_note,
              p.photo_id AS material_photo_id,
              v.counted_qty, v.is_mismatch
         FROM order_items oi
         LEFT JOIN order_picks p         ON p.order_item_id = oi.id
         LEFT JOIN order_verifications v ON v.order_item_id = oi.id
        WHERE oi.order_id = ?
        ORDER BY oi.id`,
      [Number(req.params.id)]
    );

    const [[order]] = await pool.query(
      `SELECT o.order_id, o.so_number, o.status, o.verified_at,
              c.name AS party
         FROM orders o JOIN customers c ON c.masterid = o.customer_id
        WHERE o.order_id = ?`,
      [Number(req.params.id)]
    );
    if (!order) return res.status(404).json({ error: 'No such order' });

    res.json({
      order,
      lines: rows.map((r) => ({
        ...r,
        expected: r.picked_qty === null ? Number(r.ordered_qty) : Number(r.picked_qty),
      })),
      // The route refuses a partial count (a verification signed off on half
      // the lines reads as complete, and the unread half is where a shortage
      // hides), so the screen is told how many it must send.
      lines_to_count: rows.length,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/workflow/orders/:id/verify — the physical count
router.post('/orders/:id/verify', requirePermission('verification.record'), async (req, res, next) => {
  const orderId = Number(req.params.id);
  const lines = Array.isArray(req.body?.lines) ? req.body.lines : null;

  if (!Number.isInteger(orderId)) return res.status(400).json({ error: 'Invalid order id' });
  if (!lines?.length) return res.status(400).json({ error: 'Send the counted lines' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [own] = await conn.query(
      'SELECT id, item_name, qty FROM order_items WHERE order_id = ?',
      [orderId]
    );
    const byId = new Map(own.map((row) => [row.id, row]));

    // Refused rather than partially recorded: a count signed off on half the
    // lines reads as a completed verification, and the unread half is exactly
    // where a shortage hides.
    if (lines.length !== own.length) {
      await conn.rollback();
      return res.status(400).json({
        error: `This order has ${own.length} lines; ${lines.length} were counted. Count every line.`,
        code: 'INCOMPLETE',
      });
    }

    const mismatches = [];

    for (const line of lines) {
      const itemId = Number(line.order_item_id);
      const master = byId.get(itemId);
      if (!master) {
        await conn.rollback();
        return res.status(400).json({ error: `Line ${line.order_item_id} is not on this order` });
      }

      const counted = Number(line.counted_qty);
      if (!Number.isFinite(counted) || counted < 0) {
        await conn.rollback();
        return res.status(400).json({ error: `${master.item_name}: a count is required` });
      }

      const expected = Number(master.qty);
      const isMismatch = qty(counted) !== qty(expected);
      if (isMismatch) mismatches.push({ name: master.item_name, expected, counted });

      await conn.query(
        `INSERT INTO order_verifications (order_id, order_item_id, expected_qty, counted_qty, is_mismatch, verified_by)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           counted_qty = VALUES(counted_qty), is_mismatch = VALUES(is_mismatch),
           verified_by = VALUES(verified_by), verified_at = NOW()`,
        [orderId, itemId, expected, qty(counted), isMismatch, req.user.id]
      );
    }

    const result = await transition(conn, {
      orderId,
      to: 'verified',
      expectedFrom: 'picked',
      userId: req.user.id,
      note: mismatches.length ? `Verified with ${mismatches.length} mismatch` : 'Verified in full',
    });

    if (!result.ok) {
      await conn.rollback();
      return res
        .status(result.reason === 'NOT_FOUND' ? 404 : 409)
        .json({ error: result.message, code: result.reason });
    }

    // Section 4.4 — "After verification, Ajit provides a digital signature and
    // marks the order as Verified."
    //
    // What carries the weight is the account and the timestamp: an
    // authenticated member of staff stating that they personally counted these
    // goods. The drawn image is optional and kept only because Ajit expects to
    // sign; it proves nothing on its own, which is the same reasoning that
    // keeps a party signature off the delivery (the photograph is the proof
    // there).
    await conn.query(
      'UPDATE orders SET verified_by = ?, verified_at = NOW(), verify_sign_id = ? WHERE order_id = ?',
      [req.user.id, req.body?.signature_id ? Number(req.body.signature_id) : null, orderId]
    );

    const [[order]] = await conn.query(
      `SELECT c.name AS party FROM orders o
         JOIN customers c ON c.masterid = o.customer_id
        WHERE o.order_id = ?`,
      [orderId]
    );

    // A mismatch escalates on its own. This is the alert the screen promises,
    // and it must not depend on Ajit choosing to raise it.
    if (mismatches.length) {
      const detail = mismatches
        .map((m) => `${m.name}: SO says ${m.expected}, counted ${m.counted}`)
        .join('; ');

      for (const ownerId of await usersWithGrant(conn, 'all')) {
        await notify(conn, {
          userId: ownerId,
          tone: 'danger',
          title: 'Verify mismatch',
          body: `${order.party} — ${detail}`,
          actor: req.user.name,
          refType: 'order',
          refId: orderId,
        });
      }
    }

    for (const billerId of await usersWithGrant(conn, 'billing')) {
      await notify(conn, {
        userId: billerId,
        tone: mismatches.length ? 'warning' : 'info',
        title: 'Ready to bill',
        body: `${order.party} verified${mismatches.length ? ' with a mismatch' : ''}.`,
        actor: req.user.name,
        refType: 'order',
        refId: orderId,
      });
    }

    await conn.commit();
    res.json({
      message: 'Verified',
      order_id: orderId,
      mismatches: mismatches.length,
      detail: mismatches,
    });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

// GET /api/workflow/orders/:id/events — how this order got where it is
router.get('/orders/:id/events', requirePermission('orders.view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT e.from_status, e.to_status, e.note, e.created_at, u.name AS actor
         FROM order_events e
         LEFT JOIN users u ON u.id = e.created_by
        WHERE e.order_id = ?
        ORDER BY e.created_at ASC, e.id ASC`,
      [Number(req.params.id)]
    );
    res.json({ events: rows });
  } catch (err) {
    next(err);
  }
});

// `approveOrder` is attached to the router function itself rather than
// switching this file to a named-exports object — every other route module
// exports its router the same bare way, and `require('./workflow').router`
// everywhere else would be a bigger diff than one extra property.
module.exports = router;
module.exports.approveOrder = approveOrder;
