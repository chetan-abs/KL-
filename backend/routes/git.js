const express = require('express');

const router = express.Router();
const pool = require('../config/db');
const { authenticate, requirePermission } = require('../middleware/auth');
const { numericId } = require('../middleware/params');
const { businessDay } = require('../utils/businessDay');
const { money, notify, usersWithGrant } = require('../utils/workflow');
const {
  enqueue: tallyEnqueue, purchaseXml, config: tallyConfig,
} = require('../utils/tally');

router.use(authenticate);
numericId(router);

/**
 * Goods in Transit, and the GST-bill countdown.
 *
 * Source: KL_App_Requirements_FINAL.pdf 5.2 and 5.3.
 *
 * A GIT entry exists BEFORE the purchase it becomes:
 *
 *   "When a bilty or LR number is received (typically via WhatsApp), Sibu
 *    immediately enters it into the application. No Tally entry is made at
 *    this stage."
 *
 * That is why this is its own module and its own table rather than columns on
 * purchases — for days or weeks the only thing that exists is a number on a
 * transporter's paperwork, and there is no purchase to hang it on.
 *
 * The stages are PENDING → ARRIVED → RECEIVED, with ISSUE for a consignment
 * that turned up short or damaged. ISSUE is not a failure state that stops the
 * goods being taken in; it records that they were not what the bilty said.
 */

const STAGES = {
  pending: ['arrived', 'received', 'issue'],
  // Transport confirmed the goods are in Guwahati; they may be collected from
  // the office or wait for delivery, and either way the next stop is received.
  arrived: ['received', 'issue'],
  received: ['issue'],
  issue: ['received'],
};

/** POST /api/git — record a bilty. */
router.post('/', requirePermission('purchases.create'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const {
      lr_number, supplier_id, supplier_name, transporter_id, transporter_name,
      dispatch_date, expected_date, freight_type, freight_amount = 0, note, bilty_photo_id,
    } = req.body;

    if (!lr_number || !String(lr_number).trim()) {
      return res.status(400).json({ error: 'The LR / bilty number is required.', code: 'LR_REQUIRED' });
    }
    if (!supplier_name && !supplier_id) {
      return res.status(400).json({ error: 'Name the supplier.', code: 'SUPPLIER_REQUIRED' });
    }

    await conn.beginTransaction();

    let name = supplier_name;
    let expected = expected_date;
    if (supplier_id) {
      const [[s]] = await conn.query('SELECT name, lead_days FROM suppliers WHERE id = ?', [supplier_id]);
      if (!s) { await conn.rollback(); return res.status(400).json({ error: 'Supplier not found.' }); }
      name = name || s.name;
      // "Expected arrival is auto-suggested based on supplier city (e.g. Delhi
      // + 5 days, Mumbai + 7 days), but editable." The lead time lives on the
      // supplier so the suggestion improves as the business learns it.
      if (!expected && dispatch_date && s.lead_days > 0) {
        const d = new Date(`${String(dispatch_date).slice(0, 10)}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + Number(s.lead_days));
        expected = d.toISOString().slice(0, 10);
      }
    }

    const [r] = await conn.query(
      `INSERT INTO git_entries
         (lr_number, supplier_id, supplier_name, transporter_id, transporter_name,
          dispatch_date, expected_date, freight_type, freight_amount, note,
          bilty_photo_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [String(lr_number).trim(), supplier_id || null, name, transporter_id || null,
        transporter_name || null, dispatch_date || null, expected || null,
        freight_type || null, money(freight_amount), note || null,
        bilty_photo_id || null, req.user.id]);

    await conn.commit();
    res.status(201).json({ message: 'Bilty recorded.', id: r.insertId, expected_date: expected });
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        error: `LR ${req.body.lr_number} is already on file.`, code: 'DUPLICATE_LR' });
    }
    next(err);
  } finally { conn.release(); }
});

/**
 * GET /api/git — the GIT Register (section 12), with overdue days computed.
 */
router.get('/', requirePermission('purchases.view'), async (req, res, next) => {
  try {
    const where = [];
    const params = [];
    if (req.query.status) { where.push('g.status = ?'); params.push(req.query.status); }
    if (req.query.overdue === 'true') {
      where.push("g.status IN ('pending','arrived') AND g.expected_date < CURDATE()");
    }

    const [rows] = await pool.query(
      `SELECT g.*, u.name AS created_by_name, p.invoice_no, p.challan_no,
              DATEDIFF(CURDATE(), g.expected_date) AS days_overdue
         FROM git_entries g
         LEFT JOIN users u ON u.id = g.created_by
         LEFT JOIN purchases p ON p.id = g.purchase_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY g.status = 'received', g.expected_date IS NULL, g.expected_date ASC, g.id DESC
        LIMIT 300`, params);

    // Freight payable per transporter — "This allows the business to track
    // freight payable per LR number and per transporter." (5.2)
    const [freight] = await pool.query(
      `SELECT COALESCE(transporter_name, '(unnamed)') AS transporter,
              COUNT(*) AS consignments,
              COALESCE(SUM(CASE WHEN freight_type = 'to_pay' THEN freight_amount END), 0) AS to_pay,
              COALESCE(SUM(CASE WHEN freight_type = 'paid'   THEN freight_amount END), 0) AS paid
         FROM git_entries GROUP BY transporter_name ORDER BY to_pay DESC`);

    res.json({
      entries: rows.map((g) => ({
        ...g,
        days_overdue: g.status === 'received' ? 0 : Math.max(0, Number(g.days_overdue) || 0),
      })),
      freight_by_transporter: freight,
    });
  } catch (err) { next(err); }
});

/** POST /api/git/:id/stage — move a consignment along. */
router.post('/:id/stage', requirePermission('purchases.edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const { to, note } = req.body;
    await conn.beginTransaction();
    const [[g]] = await conn.query('SELECT * FROM git_entries WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!g) { await conn.rollback(); return res.status(404).json({ error: 'Bilty not found' }); }

    if (!STAGES[g.status]?.includes(to)) {
      await conn.rollback();
      return res.status(409).json({
        error: `A consignment cannot go from ${g.status} to ${to}.`,
        code: 'BAD_STAGE',
        allowed: STAGES[g.status] || [],
      });
    }

    const stamps = {
      arrived: 'arrived_at = NOW()',
      received: 'received_at = NOW()',
    };
    await conn.query(
      `UPDATE git_entries SET status = ?${stamps[to] ? `, ${stamps[to]}` : ''}, note = COALESCE(?, note)
        WHERE id = ?`,
      [to, note || null, g.id]);

    if (to === 'issue') {
      for (const owner of await usersWithGrant(conn, 'all')) {
        await notify(conn, {
          userId: owner, tone: 'warning',
          title: `Consignment problem — LR ${g.lr_number}`,
          body: note || `${g.supplier_name}: shortage or damage found on receipt.`,
          actor: req.user.id, refType: 'git', refId: g.id });
      }
    }

    await conn.commit();
    res.json({ message: `Marked ${to}.` });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

// ---------------------------------------------------------------------------
// GST bill pending tracker — 5.3
// ---------------------------------------------------------------------------

/**
 * GET /api/git/gst-pending — "a tracker showing all challan purchases awaiting
 * their GST bill, with the number of days remaining."
 */
router.get('/gst-pending', requirePermission('purchases.view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT p.id, p.purchase_type, p.supplier_name, p.challan_no, p.purchase_date,
              p.gst_due_on, p.grand_total,
              DATEDIFF(p.gst_due_on, CURDATE()) AS days_left
         FROM purchases p
        WHERE p.doc_state = 'unregistered' AND p.gst_due_on IS NOT NULL
        ORDER BY p.gst_due_on ASC`);
    res.json({
      pending: rows,
      overdue: rows.filter((r) => Number(r.days_left) < 0).length,
    });
  } catch (err) { next(err); }
});

/**
 * POST /api/purchases/:id/gst-bill, mounted here — the GST bill arrives and
 * converts the unregistered purchase to a registered one (5.3).
 */
router.post('/gst-bill/:id', requirePermission('purchases.edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const { bill_no } = req.body;
    if (!bill_no || !String(bill_no).trim()) {
      return res.status(400).json({ error: 'The GST bill number is required.', code: 'BILL_NO_REQUIRED' });
    }
    await conn.beginTransaction();
    const [[p]] = await conn.query('SELECT * FROM purchases WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!p) { await conn.rollback(); return res.status(404).json({ error: 'Purchase not found' }); }
    if (p.doc_state !== 'unregistered') {
      await conn.rollback();
      return res.status(409).json({
        error: `That purchase is ${p.doc_state}; only an unregistered one converts.`, code: 'NOT_UNREGISTERED' });
    }

    await conn.query(
      `UPDATE purchases
          SET doc_state = 'converted', gst_bill_no = ?, gst_received_at = NOW(), invoice_no = ?
        WHERE id = ?`,
      [String(bill_no).trim(), String(bill_no).trim(), p.id]);

    // Section 14: "Unregistered Purchases (challan type) and conversion on GST
    // bill receipt". The conversion is its own push — Tally is holding an
    // unregistered voucher that now has to become a registered one, and the
    // REMOTEID is the same either way so this amends rather than duplicates.
    const [[converted]] = await conn.query('SELECT * FROM purchases WHERE id = ?', [p.id]);
    const [convLines] = await conn.query(
      `SELECT pi.*, i.unit FROM purchase_items pi
         LEFT JOIN items i ON i.masterid = pi.item_id WHERE pi.purchase_id = ?`,
      [p.id]
    );
    await tallyEnqueue(conn, {
      kind: 'purchase_conversion',
      refType: 'purchase',
      refId: p.id,
      payload: purchaseXml({
        purchase: converted, lines: convLines,
        company: tallyConfig().company, registered: true }),
      userId: req.user.id,
    });

    await conn.commit();
    res.json({ message: 'Converted to a registered purchase.' });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

// ---------------------------------------------------------------------------
// Masters the purchase screens search
// ---------------------------------------------------------------------------

router.get('/suppliers', requirePermission('purchases.view'), async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const [rows] = await pool.query(
      `SELECT * FROM suppliers WHERE is_active = TRUE ${q ? 'AND name LIKE ?' : ''}
        ORDER BY name LIMIT 100`, q ? [`%${q}%`] : []);
    res.json({ suppliers: rows });
  } catch (err) { next(err); }
});

router.post('/suppliers', requirePermission('purchases.create'), async (req, res, next) => {
  try {
    const { name, city, state, phone, gst_number, lead_days = 0 } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'A name is required.' });
    const [r] = await pool.query(
      `INSERT INTO suppliers (name, city, state, phone, gst_number, lead_days)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [String(name).trim(), city || null, state || null, phone || null, gst_number || null, Number(lead_days) || 0]);
    res.status(201).json({ message: 'Supplier added.', id: r.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'That supplier is already on file.', code: 'DUPLICATE' });
    }
    next(err);
  }
});

router.get('/transporters', requirePermission('purchases.view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM transporters WHERE is_active = TRUE ORDER BY name LIMIT 100');
    res.json({ transporters: rows });
  } catch (err) { next(err); }
});

router.post('/transporters', requirePermission('purchases.create'), async (req, res, next) => {
  try {
    const { name, phone, city } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'A name is required.' });
    const [r] = await pool.query(
      'INSERT INTO transporters (name, phone, city) VALUES (?, ?, ?)',
      [String(name).trim(), phone || null, city || null]);
    res.status(201).json({ message: 'Transporter added.', id: r.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'That transporter is already on file.', code: 'DUPLICATE' });
    }
    next(err);
  }
});

module.exports = router;
