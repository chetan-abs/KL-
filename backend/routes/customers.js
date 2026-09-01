const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authenticate, requirePermission } = require('../middleware/auth');
const { userCan } = require('../utils/permissions');
const { isCustomerType } = require('../utils/pricing');
const {
  enqueue: tallyEnqueue, ledgerMasterXml, config: tallyConfig,
} = require('../utils/tally');

router.use(authenticate);

// Columns a caller may set. A column absent from the body is left as it is —
// the previous version wrote all of them unconditionally, so a request that
// carried only { name } wiped the phone number, GST number, address, credit
// limit and coordinates, and set is_active to NULL.
const WRITABLE = [
  'name', 'group_name', 'person_name', 'phone', 'phone2', 'email', 'address',
  'pincode', 'state', 'city', 'gst_number', 'pan_number', 'credit_limit',
  'credit_days', 'category', 'customer_type', 'salesman_id',
  'latitude', 'longitude', 'is_active'
];

// GET /api/customers — List customers with search & filter
router.get('/', requirePermission('customers.view'), async (req, res, next) => {
  try {
    const { search, group_name, city, activeOnly = 'true' } = req.query;
    let sql = 'SELECT * FROM customers WHERE 1=1';
    const params = [];

    if (activeOnly === 'true') {
      sql += ' AND is_active = TRUE';
    }
    if (search) {
      sql += ' AND (name LIKE ? OR person_name LIKE ? OR phone LIKE ? OR gst_number LIKE ? OR city LIKE ?)';
      const term = `%${search.trim()}%`;
      params.push(term, term, term, term, term);
    }
    if (group_name) {
      sql += ' AND group_name = ?';
      params.push(group_name);
    }
    if (city) {
      sql += ' AND city = ?';
      params.push(city);
    }

    sql += ' ORDER BY name ASC';
    const [rows] = await pool.query(sql, params);
    res.json({ customers: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/customers/:id — Single customer
router.get('/:id', requirePermission('customers.view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM customers WHERE masterid = ?', [req.params.id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    res.json({ customer: rows[0] });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/customers/:id/credit-status — the Party Information Card, 3.3.
 *
 * "Shown at punch: credit limit, used, free, last order date, outstanding
 * amount and the age of the oldest bill — before the order is saved." A
 * salesman needs this BEFORE attempting an order, not only inside the 409 a
 * blocked punch returns, so it is its own endpoint rather than something only
 * discoverable by tripping the block in routes/orders.js.
 */
router.get('/:id/credit-status', requirePermission('customers.view'), async (req, res, next) => {
  try {
    const [[customer]] = await pool.query(
      'SELECT masterid, name, credit_limit, closing_balance FROM customers WHERE masterid = ?',
      [req.params.id]);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const [[last]] = await pool.query(
      'SELECT order_date FROM orders WHERE customer_id = ? AND is_no_order = FALSE ORDER BY order_date DESC LIMIT 1',
      [req.params.id]);
    const [[overdue]] = await pool.query(
      `SELECT COALESCE(SUM(grand_total - amount_paid), 0) AS amount, COUNT(*) AS invoices,
              MIN(invoice_date) AS oldest_date, DATEDIFF(CURDATE(), MIN(invoice_date)) AS oldest_days
         FROM invoices
        WHERE customer_id = ? AND settled_on IS NULL AND status <> 'cancelled'`,
      [req.params.id]);

    const creditLimit = Number(customer.credit_limit) || 0;
    const used = Number(customer.closing_balance) || 0;
    res.json({
      credit_limit: creditLimit,
      used,
      free: Math.max(0, creditLimit - used),
      last_order_date: last?.order_date || null,
      outstanding: Number(overdue.amount) || 0,
      outstanding_invoices: overdue.invoices || 0,
      oldest_bill_days: overdue.oldest_date ? overdue.oldest_days : null,
      overdue_60: overdue.oldest_date && overdue.oldest_days > 60,
    });
  } catch (err) { next(err); }
});

// POST /api/customers — Create / Onboard Customer
router.post('/', requirePermission('customers.create'), async (req, res, next) => {
  try {
    const {
      name,
      group_name = 'General',
      person_name,
      phone,
      phone2,
      email,
      address,
      pincode,
      state,
      city,
      gst_number,
      pan_number,
      credit_limit,
      credit_days = 0,
      category = 'Retailer',
      latitude,
      longitude,
      // The six types of section 3. Nullable rather than defaulted: the type
      // decides which of an item's six rates the party is billed at, and a
      // party silently defaulted to 'dealer' would be sold to at list less
      // 52%. POST /orders refuses an unclassified party for the same reason.
      customer_type = null,
      // "If the party is new, the user selects from a dropdown. The salesman is
      // then permanently tagged to this party." (4.1)
      salesman_id = null,
      // 3.1, "Walk-in default" — an explicit opt-in, not an inference from a
      // missing field. "Unregistered walk-in defaults to Retail Direct (Col
      // 8) — the highest column, never a cheaper one." This is the one
      // deliberate carve-out from the no-silent-default rule above: it only
      // fires when the counter says so, never for an ordinary onboarding
      // that simply omitted a type.
      walkin = false,
    } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ error: 'Customer/Shop name is required' });
    }
    if (walkin && !phone?.trim()) {
      return res.status(400).json({
        error: 'A walk-in sale needs a phone number.', code: 'WALKIN_PHONE_REQUIRED' });
    }
    const resolvedType = customer_type || (walkin ? 'retail_direct' : null);
    if (Number(credit_limit) < 0) {
      return res.status(400).json({ error: 'Credit limit cannot be negative' });
    }
    if (resolvedType && !isCustomerType(resolvedType)) {
      return res.status(400).json({
        error: `"${resolvedType}" is not one of the six customer types.`,
        code: 'BAD_CUSTOMER_TYPE',
      });
    }
    // 3.3 — "New party is capped at ₹50,000 until three clean months." Only
    // applied when nobody named a figure; an explicit 0 or any other number
    // from whoever is allowed to set this (Manoj or a Super Admin) is taken
    // as meant, never silently overridden.
    const resolvedCreditLimit = credit_limit === undefined || credit_limit === null
      || credit_limit === '' ? 50000 : Number(credit_limit);

    const [result] = await pool.query(
      `INSERT INTO customers (name, group_name, person_name, phone, phone2, email, address, pincode, state, city, gst_number, pan_number, credit_limit, credit_days, category, customer_type, salesman_id, latitude, longitude, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE)`,
      [
        name.trim(),
        group_name,
        person_name || null,
        phone || null,
        phone2 || null,
        email || null,
        address || null,
        pincode || null,
        state || null,
        city || null,
        gst_number || null,
        pan_number || null,
        resolvedCreditLimit,
        Number(credit_days) || 0,
        category,
        resolvedType,
        salesman_id,
        latitude ?? null,
        longitude ?? null
      ]
    );

    const [[customer]] = await pool.query('SELECT * FROM customers WHERE masterid = ?', [result.insertId]);

    // Section 14: "New party and item creation" App -> Tally. A party onboarded
    // in the field has to exist as a ledger before the invoice that references
    // it can post, and the queue is drained in id order, so enqueueing here
    // guarantees the ordering without anything having to know about it.
    //
    // Skipped for a party that came FROM Tally: group_name 'Tally' is what the
    // puller sets, and pushing it straight back would be a pointless round trip.
    if (customer.group_name !== 'Tally') {
      const conn = await pool.getConnection();
      try {
        await tallyEnqueue(conn, {
          kind: 'ledger_master',
          refType: 'customer',
          refId: result.insertId,
          payload: ledgerMasterXml({ customer, company: tallyConfig().company }),
          userId: req.user.id,
        });
      } finally { conn.release(); }
    }

    res.status(201).json({
      message: 'Customer onboarded successfully',
      masterid: result.insertId,
      customer
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/customers/:id — Partial update
router.put('/:id', requirePermission('customers.edit'), async (req, res, next) => {
  try {
    // 3.3 — "Set by Papa or a Super Admin." Anyone holding customers.edit can
    // fix a phone number or address; only an owner may move the figure that
    // decides whether an order gets blocked at punch.
    if (req.body.credit_limit !== undefined && !userCan(req.user, 'all')) {
      return res.status(403).json({
        error: 'The credit limit is set by Yash or Manoj only.', code: 'CREDIT_LIMIT_DENIED' });
    }

    const updates = [];
    const values = [];

    for (const column of WRITABLE) {
      if (req.body[column] !== undefined) {
        updates.push(`${column} = ?`);
        values.push(req.body[column]);
      }
    }

    if (!updates.length) {
      return res.status(400).json({ error: 'Nothing to update' });
    }
    if (req.body.name !== undefined && !String(req.body.name).trim()) {
      return res.status(400).json({ error: 'Customer name cannot be empty' });
    }
    // Validated here as well as on create: the type decides which of six rates
    // the party is billed at, and an unrecognised string would reach the
    // pricing engine and stop every order for that party.
    if (req.body.customer_type !== undefined && req.body.customer_type !== null
        && !isCustomerType(req.body.customer_type)) {
      return res.status(400).json({
        error: `"${req.body.customer_type}" is not one of the six customer types.`,
        code: 'BAD_CUSTOMER_TYPE',
      });
    }

    values.push(req.params.id);
    const [result] = await pool.query(
      `UPDATE customers SET ${updates.join(', ')} WHERE masterid = ?`,
      values
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const [[customer]] = await pool.query('SELECT * FROM customers WHERE masterid = ?', [req.params.id]);

    // Section 14 keeps the party master flowing Tally -> App, but a party
    // created HERE was pushed the other way and Tally knows it by name. If the
    // name changed, Tally has to be told — an alter under the new name would
    // otherwise create a SECOND ledger and leave the first holding the history.
    // utils/tally.js looks the party up under tally_links.tally_name to make it
    // a rename instead.
    const [[link]] = await pool.query(
      "SELECT tally_name FROM tally_links WHERE entity = 'customer' AND local_id = ?",
      [String(req.params.id)]);

    if (link && link.tally_name && link.tally_name !== customer.name) {
      const conn = await pool.getConnection();
      try {
        await tallyEnqueue(conn, {
          kind: 'ledger_master',
          refType: 'customer',
          refId: Number(req.params.id),
          payload: ledgerMasterXml({
            customer, company: tallyConfig().company, previousName: link.tally_name }),
          userId: req.user.id,
        });
      } finally { conn.release(); }
    }

    res.json({ message: 'Customer updated successfully', customer });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
