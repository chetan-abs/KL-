/**
 * FIFO payment matching, and the dealer cash discount it makes possible.
 *
 * Source: KL_App_Requirements_FINAL.pdf 3.3.
 *
 *   "Payment matching follows FIFO — the oldest unpaid invoice is settled
 *    first. When a qualifying payment is received, the application
 *    automatically generates a credit note for the applicable cash discount
 *    amount and syncs it to Tally."
 *
 * Everything here depends on knowing WHICH invoice a payment cleared. Before
 * payment_allocations existed a payment was a number against a party, and both
 * the cash discount (a function of the age of the invoice being settled) and
 * the 60-day incentive rule (a function of when a specific invoice was paid)
 * were uncomputable — there was nothing to compute them from.
 *
 * The discount is a credit note, never a reduction of the invoice. The invoice
 * was correct; the party earned something by paying early, and both are facts
 * the ledger has to keep separately.
 */

const { money, recomputeBalance, nextDocNumber, notify } = require('./workflow');
const { CASH_DISCOUNT_TYPES } = require('./pricing');

/**
 * Spread a receipt across the party's open invoices, oldest first.
 *
 * Returns the allocations written, and any amount left over. An overpayment is
 * NOT forced onto a future invoice: it stays unallocated and shows as an
 * advance on the party's account, because guessing which invoice it belongs to
 * is exactly the guess the FIFO rule exists to remove.
 *
 * Called inside the caller's transaction.
 */
async function allocateFifo(conn, { paymentId, customerId, amount, paymentDate }) {
  let remaining = money(amount);
  const allocations = [];

  const [open] = await conn.query(
    `SELECT id, invoice_no, invoice_date, grand_total, amount_paid
       FROM invoices
      WHERE customer_id = ? AND status <> 'cancelled'
        AND grand_total > amount_paid
      ORDER BY invoice_date ASC, id ASC
      FOR UPDATE`,
    [customerId],
  );

  for (const inv of open) {
    if (remaining <= 0.004) break;
    const owed = money(Number(inv.grand_total) - Number(inv.amount_paid));
    if (owed <= 0) continue;

    const take = money(Math.min(owed, remaining));
    const ageDays = daysBetween(inv.invoice_date, paymentDate);

    await conn.query(
      `INSERT INTO payment_allocations (payment_id, invoice_id, amount, age_days)
       VALUES (?, ?, ?, ?)`,
      [paymentId, inv.id, take, ageDays],
    );

    const nowPaid = money(Number(inv.amount_paid) + take);
    const settled = nowPaid >= money(Number(inv.grand_total)) - 0.004;
    await conn.query(
      'UPDATE invoices SET amount_paid = ?, settled_on = ? WHERE id = ?',
      [nowPaid, settled ? String(paymentDate).slice(0, 10) : null, inv.id],
    );

    allocations.push({
      invoice_id: inv.id,
      invoice_no: inv.invoice_no,
      invoice_date: inv.invoice_date,
      amount: take,
      age_days: ageDays,
      settled,
    });
    remaining = money(remaining - take);
  }

  return { allocations, unallocated: remaining };
}

/**
 * Undo the allocations of a payment that is being reversed.
 *
 * A bounced cheque reverses the receipt it paid for — the standing invariant —
 * and that has to put the invoices back to unpaid, or the ledger says settled
 * while the bank says otherwise. The allocation rows go with it: they recorded
 * a settlement that did not happen.
 */
async function reverseAllocations(conn, paymentId) {
  const [rows] = await conn.query(
    'SELECT invoice_id, amount FROM payment_allocations WHERE payment_id = ?',
    [paymentId],
  );
  for (const r of rows) {
    await conn.query(
      `UPDATE invoices
          SET amount_paid = GREATEST(0, amount_paid - ?), settled_on = NULL
        WHERE id = ?`,
      [money(r.amount), r.invoice_id],
    );
  }
  await conn.query('DELETE FROM payment_allocations WHERE payment_id = ?', [paymentId]);
  return rows.length;
}

/** Whole days from the invoice date to the payment date. */
function daysBetween(from, to) {
  const a = new Date(`${String(from).slice(0, 10)}T00:00:00Z`);
  const b = new Date(`${String(to).slice(0, 10)}T00:00:00Z`);
  return Math.max(0, Math.round((b - a) / 86400000));
}

/** The band an age falls in, or null past the last one. */
async function bandFor(conn, ageDays) {
  const [[band]] = await conn.query(
    `SELECT * FROM cash_discount_bands
      WHERE is_active = TRUE AND ? BETWEEN min_days AND max_days
      ORDER BY min_days ASC LIMIT 1`,
    [ageDays],
  );
  return band || null;
}

/**
 * The cash-discount credit note for a receipt (3.3).
 *
 * Dealers only — "This discount is available only for Dealer type customers.
 * It does not apply to any other customer type." The check is on the party's
 * classification, read here rather than trusted from the caller.
 *
 * One note per payment covering every allocation that qualified, rather than
 * one per invoice: the party receives one credit for one payment, and the
 * detail of which invoices earned it is in the note's own text.
 */
async function issueCashDiscount(conn, { paymentId, customerId, allocations, actorId }) {
  const [[customer]] = await conn.query(
    'SELECT masterid, name, customer_type FROM customers WHERE masterid = ?',
    [customerId],
  );
  if (!customer || !CASH_DISCOUNT_TYPES.has(customer.customer_type)) return null;

  let total = 0;
  const detail = [];
  for (const a of allocations) {
    const band = await bandFor(conn, a.age_days);
    if (!band) continue;
    const amount = money(Number(a.amount) * Number(band.percent));
    if (amount <= 0) continue;
    total = money(total + amount);
    detail.push(`${a.invoice_no} ${a.age_days}d ${(Number(band.percent) * 100).toFixed(1)}% = ${amount.toFixed(2)}`);
  }
  if (total <= 0) return null;

  const noteNo = await nextDocNumber(conn, {
    table: 'credit_notes', column: 'note_no', prefix: 'CD-', width: 5,
  });

  // Raised as 'pending'. A cash-discount note is generated automatically, but
  // it is still a credit note — it moves the party's balance only once issued,
  // and the standing invariant is that a pending note deliberately does not.
  const [res] = await conn.query(
    `INSERT INTO credit_notes
       (note_no, customer_id, invoice_id, return_id, amount, reason, origin,
        payment_id, status, note_date, issued_by)
     VALUES (?, ?, NULL, NULL, ?, ?, 'cash_discount', ?, 'pending', CURDATE(), ?)`,
    [noteNo, customerId, total, `Cash discount: ${detail.join('; ')}`, paymentId, actorId],
  );

  // Recorded on the invoices too, so the Cash Discount Report can be read
  // party-by-party without unpicking note text.
  for (const a of allocations) {
    const band = await bandFor(conn, a.age_days);
    if (!band) continue;
    await conn.query(
      'UPDATE invoices SET cd_percent = ?, cd_amount = cd_amount + ? WHERE id = ?',
      [band.percent, money(Number(a.amount) * Number(band.percent)), a.invoice_id],
    );
  }

  await recomputeBalance(conn, customerId);

  await notify(conn, {
    userId: null,
    tone: 'info',
    title: `Cash discount ${noteNo}`,
    body: `${customer.name} earned ${total.toFixed(2)} for early payment. Approve to post it.`,
    actor: actorId,
    refType: 'credit_note',
    refId: res.insertId,
  });

  return { credit_note_id: res.insertId, note_no: noteNo, amount: total, detail };
}

/**
 * The party's ageing, in the three buckets the Outstanding Report wants
 * (section 12), and the 60-day figure the order screen warns on (R-17).
 */
async function ageing(conn, customerId) {
  const [[row]] = await conn.query(
    `SELECT
       COALESCE(SUM(CASE WHEN DATEDIFF(CURDATE(), invoice_date) <= 30
                         THEN grand_total - amount_paid END), 0) AS b0_30,
       COALESCE(SUM(CASE WHEN DATEDIFF(CURDATE(), invoice_date) BETWEEN 31 AND 60
                         THEN grand_total - amount_paid END), 0) AS b31_60,
       COALESCE(SUM(CASE WHEN DATEDIFF(CURDATE(), invoice_date) > 60
                         THEN grand_total - amount_paid END), 0) AS b60_plus,
       COALESCE(SUM(grand_total - amount_paid), 0) AS total,
       SUM(CASE WHEN DATEDIFF(CURDATE(), invoice_date) > 60 THEN 1 ELSE 0 END) AS overdue_count
     FROM invoices
     WHERE customer_id = ? AND status <> 'cancelled' AND grand_total > amount_paid`,
    [customerId],
  );
  return {
    b0_30: money(row.b0_30),
    b31_60: money(row.b31_60),
    b60_plus: money(row.b60_plus),
    total: money(row.total),
    overdue_count: Number(row.overdue_count || 0),
  };
}

module.exports = {
  allocateFifo,
  reverseAllocations,
  issueCashDiscount,
  bandFor,
  daysBetween,
  ageing,
};
