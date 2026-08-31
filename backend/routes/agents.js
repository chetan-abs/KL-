/**
 * Commission agents and what they earn.
 *
 *   GET  /api/agents?phone=…   lookup, the way screen 05 searches
 *   GET  /api/agents/:id       one agent with their running totals
 *   POST /api/agents           create a permanent ledger
 *   PUT  /api/agents/:id       edit
 *   POST /api/agents/:id/commissions   book commission against an order
 *   GET  /api/agents/:id/commissions   their ledger
 *
 * Agent identity and commission never reach an invoice (R21). Nothing in
 * routes/invoices.js reads these tables, and that is deliberate: the party must
 * not see what their agent is paid.
 */
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authenticate, requirePermission } = require('../middleware/auth');
const { numericId } = require('../middleware/params');
const { money } = require('../utils/workflow');

router.use(authenticate);

// Rejects a non-numeric :id before any handler binds it into SQL.
numericId(router);

const AGENT_TYPES = ['builder', 'electrician'];

/**
 * Digits only, so a number keyed as "98765-11223" finds one saved as
 * "9876511223". The stored value keeps whatever formatting it was given; only
 * the comparison is normalised.
 */
const digits = (value) => String(value || '').replace(/\D/g, '');

// GET /api/agents — search by phone, or list
router.get('/', requirePermission('agents.view'), async (req, res, next) => {
  try {
    const { phone, q } = req.query;

    if (phone) {
      const [rows] = await pool.query(
        `SELECT a.*,
                COALESCE(pending.total, 0)   AS pending_amount,
                COALESCE(monthly.total, 0)   AS month_amount
           FROM agents a
           LEFT JOIN (
             SELECT agent_id, SUM(amount) AS total FROM agent_commissions
              WHERE status = 'pending' GROUP BY agent_id
           ) pending ON pending.agent_id = a.id
           LEFT JOIN (
             SELECT agent_id, SUM(amount) AS total FROM agent_commissions
              WHERE created_at >= DATE_FORMAT(NOW(), '%Y-%m-01') GROUP BY agent_id
           ) monthly ON monthly.agent_id = a.id
          WHERE REPLACE(REPLACE(REPLACE(a.phone,'-',''),' ',''),'+','') = ?
            AND a.is_active = TRUE
          LIMIT 1`,
        [digits(phone)]
      );

      // 200 with agent:null rather than 404 — "no agent on that number" is the
      // expected answer to a search, not a failure, and the screen offers to
      // create one from it.
      return res.json({ agent: rows[0] || null });
    }

    const params = [];
    let sql = 'SELECT * FROM agents WHERE is_active = TRUE';
    if (q) {
      sql += ' AND (name LIKE ? OR phone LIKE ?)';
      params.push(`%${q}%`, `%${q}%`);
    }
    sql += ' ORDER BY name LIMIT 200';

    const [rows] = await pool.query(sql, params);
    res.json({ agents: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/agents/:id
router.get('/:id', requirePermission('agents.view'), async (req, res, next) => {
  try {
    const [[agent]] = await pool.query('SELECT * FROM agents WHERE id = ?', [Number(req.params.id)]);
    if (!agent) return res.status(404).json({ error: 'No such agent' });
    res.json({ agent });
  } catch (err) {
    next(err);
  }
});

// POST /api/agents
router.post('/', requirePermission('agents.create'), async (req, res, next) => {
  const { name, phone, agent_type, area, profession } = req.body || {};

  if (!String(name || '').trim()) return res.status(400).json({ error: 'An agent needs a name' });
  if (!digits(phone)) return res.status(400).json({ error: 'An agent needs a phone number' });
  if (!AGENT_TYPES.includes(agent_type)) {
    return res.status(400).json({
      error: 'agent_type must be builder or electrician — it selects the commission column',
    });
  }

  try {
    const [result] = await pool.query(
      `INSERT INTO agents (name, phone, agent_type, area, profession, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [String(name).trim(), String(phone).trim(), agent_type, area || null, profession || null, req.user.id]
    );
    res.status(201).json({ message: 'Agent created', agent_id: result.insertId });
  } catch (err) {
    // Caught rather than pre-checked: a SELECT-then-INSERT cannot be made
    // race-free, so the unique key is what actually decides.
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'An agent already exists on that number', code: 'DUPLICATE_PHONE' });
    }
    next(err);
  }
});

// PUT /api/agents/:id
router.put('/:id', requirePermission('agents.edit'), async (req, res, next) => {
  const { name, phone, agent_type, area, profession, is_active } = req.body || {};

  if (agent_type !== undefined && !AGENT_TYPES.includes(agent_type)) {
    return res.status(400).json({ error: 'agent_type must be builder or electrician' });
  }

  const sets = [];
  const params = [];
  for (const [column, value] of Object.entries({ name, phone, agent_type, area, profession, is_active })) {
    if (value !== undefined) {
      sets.push(`${column} = ?`);
      params.push(value);
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

  try {
    params.push(Number(req.params.id));
    const [result] = await pool.query(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`, params);
    if (!result.affectedRows) return res.status(404).json({ error: 'No such agent' });
    res.json({ message: 'Agent updated' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Another agent already uses that number' });
    }
    next(err);
  }
});

// GET /api/agents/:id/commissions
router.get('/:id/commissions', requirePermission('agents.view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT ac.*, c.name AS party, oi.item_name
         FROM agent_commissions ac
         JOIN orders o    ON o.order_id = ac.order_id
         JOIN customers c ON c.masterid = o.customer_id
         LEFT JOIN order_items oi ON oi.id = ac.order_item_id
        WHERE ac.agent_id = ?
        ORDER BY ac.created_at DESC
        LIMIT 200`,
      [Number(req.params.id)]
    );
    res.json({ commissions: rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/agents/:id/commissions — book commission for an order
router.post('/:id/commissions', requirePermission('agents.create'), async (req, res, next) => {
  const agentId = Number(req.params.id);
  const orderId = Number(req.body?.order_id);
  const lines = Array.isArray(req.body?.lines) ? req.body.lines : null;

  if (!Number.isInteger(agentId) || !Number.isInteger(orderId)) {
    return res.status(400).json({ error: 'agent_id and order_id are required' });
  }
  if (!lines?.length) return res.status(400).json({ error: 'Send at least one commission line' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[agent]] = await conn.query('SELECT id FROM agents WHERE id = ? AND is_active = TRUE', [agentId]);
    if (!agent) {
      await conn.rollback();
      return res.status(404).json({ error: 'No such agent' });
    }

    // Lines are matched against the order's own items so a request cannot book
    // commission against a line belonging to somebody else's order.
    const [own] = await conn.query('SELECT id FROM order_items WHERE order_id = ?', [orderId]);
    const ownIds = new Set(own.map((row) => row.id));

    let total = 0;
    for (const line of lines) {
      const orderItemId = line.order_item_id === undefined ? null : Number(line.order_item_id);
      if (orderItemId !== null && !ownIds.has(orderItemId)) {
        await conn.rollback();
        return res.status(400).json({ error: `Line ${orderItemId} is not on order ${orderId}` });
      }

      const sale = money(Math.max(0, Number(line.sale_amount) || 0));
      const percent = Math.min(Math.max(Number(line.percent) || 0, 0), 100);
      const amount = money(sale * (percent / 100));
      total = money(total + amount);

      await conn.query(
        `INSERT INTO agent_commissions (agent_id, order_id, order_item_id, sale_amount, percent, amount)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [agentId, orderId, orderItemId, sale, percent, amount]
      );
    }

    await conn.commit();
    res.status(201).json({ message: 'Commission recorded', total });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
