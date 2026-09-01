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
/**
 * Records one receipt against a party's account — the FIFO allocation, the
 * dealer cash discount if one was earned, the Tally push and the balance
 * recompute. Extracted so a second caller can raise a receipt exactly the
 * same way instead of a parallel implementation: `routes/dispatch.js` uses
 * this for "collection at delivery" (4.4, September 2026) — a driver
 * collecting cash or a cheque against the invoice they are handing over is
 * the same fact as a receipt recorded at the desk, just recorded by whoever
 * was standing in front of the party at the time.
 *
 * Runs inside the caller's transaction and does not commit. Throws on a
 * missing customer or a bad amount/mode rather than returning an error
 * shape — both callers already have their own request validation before
 * this is reached, so those are truly exceptional here.
 */
async function recordPayment(conn, {
  customerId, invoiceId = null, chequeId = null, amount, mode = 'cash',
  paymentDate = null, note = null, userId,
}) {
  const value = money(Number(amount));
  if (!Number.isFinite(value) || value <= 0) {
    throw Object.assign(new Error('A receipt needs an amount greater than zero'), { status: 400 });
  }
  if (mode && !MODES.includes(mode)) {
    throw Object.assign(new Error(`mode must be one of ${MODES.join(', ')}`), { status: 400 });
  }

  // Locked because the balance is about to be recomputed from it.
  const [[party]] = await conn.query(
    'SELECT masterid, name FROM customers WHERE masterid = ? FOR UPDATE',
    [Number(customerId)]
  );
  if (!party) throw Object.assign(new Error('No such customer'), { status: 404 });

  const receiptNo = await nextDocNumber(conn, {
    table: 'payments', column: 'receipt_no', prefix: 'RC-', width: 4,
  });
  const resolvedDate = requestedDay(paymentDate) || businessDay();

  const [inserted] = await conn.query(
    `INSERT INTO payments
       (receipt_no, customer_id, invoice_id, cheque_id, amount, mode, payment_date, note, collected_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [receiptNo, Number(customerId), invoiceId ? Number(invoiceId) : null,
      chequeId ? Number(chequeId) : null, value, MODES.includes(mode) ? mode : 'cash',
      resolvedDate, note, userId],
  );

  // FIFO matching (3.3) — "the oldest unpaid invoice is settled first".
  //
  // An explicit invoice_id on the request does NOT bypass this. The rule is
  // the business's, not the operator's, and letting a receipt be pointed at
  // a chosen invoice is exactly how a party's oldest debt stays oldest while
  // the cash discount is earned on a fresh one.
  const { allocations, unallocated } = await allocateFifo(conn, {
    paymentId: inserted.insertId, customerId: Number(customerId), amount: value, paymentDate: resolvedDate,
  });

  // The dealer cash discount, if this receipt earned one. Returns null for
  // every other customer type and for a payment that cleared nothing inside
  // a discount band.
  const creditNote = await issueCashDiscount(conn, {
    paymentId: inserted.insertId, customerId: Number(customerId), allocations, actorId: userId,
  });

  // Section 14: "Payment receipts" App -> Tally.
  const [[receiptRow]] = await conn.query(
    `SELECT p.*, c.name AS party_name FROM payments p
       JOIN customers c ON c.masterid = p.customer_id WHERE p.id = ?`,
    [inserted.insertId]
  );
  await tallyEnqueue(conn, {
    kind: 'receipt', refType: 'payment', refId: inserted.insertId,
    payload: receiptXml({ payment: receiptRow, company: tallyConfig().company }),
    userId,
  });

  await recomputeBalance(conn, Number(customerId));
  const [[updated]] = await conn.query(
    'SELECT closing_balance FROM customers WHERE masterid = ?', [Number(customerId)]);

  return {
    payment_id: inserted.insertId,
    receipt_no: receiptNo,
    closing_balance: updated.closing_balance,
    allocations,
    unallocated,
    cash_discount: creditNote,
  };
}

router.post('/', requirePermission('payments.create'), async (req, res, next) => {
  const { customer_id, invoice_id, cheque_id, amount, mode, payment_date, note } = req.body || {};

  if (!Number.isInteger(Number(customer_id))) {
    return res.status(400).json({ error: 'customer_id is required' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const result = await recordPayment(conn, {
      customerId: customer_id, invoiceId: invoice_id, chequeId: cheque_id,
      amount, mode, paymentDate: payment_date, note, userId: req.user.id,
    });

    await conn.commit();
    res.status(201).json({ message: 'Receipt recorded', ...result });
  } catch (err) {
    await conn.rollback();
    if (err.status) return res.status(err.status).json({ error: err.message });
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
module.exports.recordPayment = recordPayment;
