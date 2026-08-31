/**
 * Receipts — money in against a party's account.
 *
 *   GET  /api/payments               recent receipts
 *   GET  /api/payments/outstanding   who owes what, by ageing
 *   POST /api/payments               record one
 *   POST /api/payments/:id/reverse   undo one (a bounced cheque, a keying error)
 *
 * This is the piece the app was reporting on and nobody was writing. Every
 * receipt recomputes customers.closing_balance in the same transaction, so the
 * "Outstanding" on the approval screen and the ageing on the register finally
 * describe something real.
 *
 * A reversal is a status change, never a delete: a payment that arrived and was
 * then returned is two facts, and the second does not erase the first.
 */
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authenticate, requirePermission } = require('../middleware/auth');
const {
  allocateFifo, reverseAllocations, issueCashDiscount,
} = require('../utils/cashDiscount');
const {
  enqueue: tallyEnqueue, receiptXml, config: tallyConfig,
} = require('../utils/tally');
const { numericId } = require('../middleware/params');
const { money, recomputeBalance, notify, nextDocNumber } = require('../utils/workflow');
const { businessDay, requestedDay } = require('../utils/businessDay');

router.use(authenticate);

// Rejects a non-numeric :id before any handler binds it into SQL.
numericId(router);

const MODES = ['cash', 'cheque', 'upi', 'bank'];

// GET /api/payments
router.get('/', requirePermission('payments.view'), async (req, res, next) => {
  try {
    const params = [];
    let sql = `
      SELECT p.*, c.name AS party, i.invoice_no, u.name AS collected_by_name
        FROM payments p
        JOIN customers c ON c.masterid = p.customer_id
        LEFT JOIN invoices i ON i.id = p.invoice_id
        LEFT JOIN users u   ON u.id = p.collected_by
       WHERE 1=1
    `;
    if (req.query.customer_id) {
      sql += ' AND p.customer_id = ?';
      params.push(Number(req.query.customer_id));
    }
    if (req.query.date) {
      sql += ' AND p.payment_date = ?';
      params.push(requestedDay(req.query.date));
    }
    sql += ' ORDER BY p.id DESC LIMIT 100';

    const [rows] = await pool.query(sql, params);
    res.json({ payments: rows });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/payments/outstanding
 *
 * Read from the cached balance rather than recomputed per row: this is a list
 * screen sorted by ageing, and three correlated subqueries per party is what the
 * cache exists to avoid. `days` is the age of the oldest unpaid invoice, which
 * is what "62d due" on the approval screen means.
 */
router.get('/outstanding', requirePermission('payments.view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT c.masterid, c.name, c.city AS area, c.category AS type,
              c.closing_balance AS outstanding,
              DATEDIFF(CURDATE(), MIN(i.invoice_date)) AS days
         FROM customers c
         LEFT JOIN invoices i
           ON i.customer_id = c.masterid AND i.status = 'issued'
        WHERE c.is_active = TRUE
        GROUP BY c.masterid, c.name, c.city, c.category, c.closing_balance
        ORDER BY c.closing_balance > 0 DESC, days DESC
        LIMIT 200`
    );
    res.json({ parties: rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/payments
router.post('/', requirePermission('payments.create'), async (req, res, next) => {
  const { customer_id, invoice_id, cheque_id, amount, mode, payment_date, note } = req.body || {};

  if (!Number.isInteger(Number(customer_id))) {
    return res.status(400).json({ error: 'customer_id is required' });
  }
  const value = money(Number(amount));
  if (!Number.isFinite(value) || value <= 0) {
    return res.status(400).json({ error: 'A receipt needs an amount greater than zero' });
  }
  if (mode && !MODES.includes(mode)) {
    return res.status(400).json({ error: `mode must be one of ${MODES.join(', ')}` });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Locked because the balance is about to be recomputed from it.
    const [[party]] = await conn.query(
      'SELECT masterid, name FROM customers WHERE masterid = ? FOR UPDATE',
      [Number(customer_id)]
    );
    if (!party) {
      await conn.rollback();
      return res.status(404).json({ error: 'No such customer' });
    }

    const receiptNo = await nextDocNumber(conn, {
      table: 'payments',
      column: 'receipt_no',
      prefix: 'RC-',
      width: 4,
    });

    const [inserted] = await conn.query(
      `INSERT INTO payments
         (receipt_no, customer_id, invoice_id, cheque_id, amount, mode, payment_date, note, collected_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        receiptNo,
        Number(customer_id),
        invoice_id ? Number(invoice_id) : null,
        cheque_id ? Number(cheque_id) : null,
        value,
        MODES.includes(mode) ? mode : 'cash',
        requestedDay(payment_date) || businessDay(),
        note || null,
        req.user.id,
      ]
    );

    const paymentDate = requestedDay(payment_date) || businessDay();

    // FIFO matching (3.3) — "the oldest unpaid invoice is settled first".
    //
    // An explicit invoice_id on the request does NOT bypass this. The rule is
    // the business's, not the operator's, and letting a receipt be pointed at
    // a chosen invoice is exactly how a party's oldest debt stays oldest while
    // the cash discount is earned on a fresh one.
    const { allocations, unallocated } = await allocateFifo(conn, {
      paymentId: inserted.insertId,
      customerId: Number(customer_id),
      amount: value,
      paymentDate,
    });

    // The dealer cash discount, if this receipt earned one. Returns null for
    // every other customer type and for a payment that cleared nothing inside
    // a discount band.
    const creditNote = await issueCashDiscount(conn, {
      paymentId: inserted.insertId,
      customerId: Number(customer_id),
      allocations,
      actorId: req.user.id,
    });

    // Section 14: "Payment receipts" App -> Tally.
    const [[receiptRow]] = await conn.query(
      `SELECT p.*, c.name AS party_name FROM payments p
         JOIN customers c ON c.masterid = p.customer_id WHERE p.id = ?`,
      [inserted.insertId]
    );
    await tallyEnqueue(conn, {
      kind: 'receipt',
      refType: 'payment',
      refId: inserted.insertId,
      payload: receiptXml({ payment: receiptRow, company: tallyConfig().company }),
      userId: req.user.id,
    });

    // Section 14: "Cash Discount Credit Notes (auto, FIFO calculation)". Raised
    // as pending, so it is queued when an owner issues it, not now — a pending
    // note is not yet money the party may set against their account.
    await recomputeBalance(conn, Number(customer_id));

    const [[updated]] = await conn.query(
      'SELECT closing_balance FROM customers WHERE masterid = ?',
      [Number(customer_id)]
    );

    await conn.commit();
    res.status(201).json({
      message: 'Receipt recorded',
      payment_id: inserted.insertId,
      receipt_no: receiptNo,
      closing_balance: updated.closing_balance,
      allocations,
      // Money received that settled nothing: it stays on account rather than
      // being pushed onto an invoice that has not been raised yet.
      unallocated,
      cash_discount: creditNote,
    });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// POST /api/payments/:id/reverse
router.post('/:id/reverse', requirePermission('payments.create'), async (req, res, next) => {
  const reason = String(req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'A reversal needs a reason' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[payment]] = await conn.query(
      'SELECT * FROM payments WHERE id = ? FOR UPDATE',
      [Number(req.params.id)]
    );
    if (!payment) {
      await conn.rollback();
      return res.status(404).json({ error: 'No such receipt' });
    }
    if (payment.status === 'reversed') {
      await conn.rollback();
      return res.status(409).json({ error: 'That receipt is already reversed' });
    }

    // Status change, not a delete. The receipt happened; so did the reversal.
    await conn.query(
      "UPDATE payments SET status = 'reversed', note = CONCAT(COALESCE(note,''), ' | reversed: ', ?) WHERE id = ?",
      [reason, payment.id]
    );

    // The allocations go with it. They recorded invoices as settled by money
    // that has since been returned; leaving them would report the party as
    // paid up while the bank says otherwise — the one disagreement a cash book
    // must never have.
    await reverseAllocations(conn, payment.id);

    // A cash discount earned on a receipt that bounced was not earned. The
    // note is cancelled rather than deleted: it was issued, and that is a fact
    // the party may already have seen.
    await conn.query(
      `UPDATE credit_notes SET status = 'cancelled',
             reason = CONCAT(COALESCE(reason,''), ' | cancelled: receipt reversed')
        WHERE payment_id = ? AND status <> 'cancelled'`,
      [payment.id]
    );

    await recomputeBalance(conn, payment.customer_id);

    const [[party]] = await conn.query(
      'SELECT name, closing_balance FROM customers WHERE masterid = ?',
      [payment.customer_id]
    );

    await notify(conn, {
      tone: 'warning',
      title: 'Receipt reversed',
      body: `${party.name} — ${payment.receipt_no} for ₹${payment.amount} reversed: ${reason}`,
      actor: req.user.name,
      refType: 'payment',
      refId: payment.id,
    });

    await conn.commit();
    res.json({ message: 'Receipt reversed', closing_balance: party.closing_balance });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
