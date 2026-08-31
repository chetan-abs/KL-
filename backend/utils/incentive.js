/**
 * The 20-segment salesman incentive.
 *
 * Source: KL_App_Requirements_FINAL.pdf section 9, rules R-18 and R-19.
 *
 * Two rules do the work, and they interact:
 *
 *   the slab      below 90% of target pays nothing; 90–99% pays 80% of the
 *                 base; 100% pays the base; 101%+ pays 110%, and that is the
 *                 ceiling.
 *
 *   payment-linked (R-19) a sale only counts once the customer has paid, and
 *                 an invoice unpaid beyond 60 days is REMOVED from the
 *                 achievement. So the achievement is not "what was sold" but
 *                 "what was sold and stands a chance of being collected", and
 *                 it can go down as well as up.
 *
 * The two are kept visibly apart on every line — achieved_gross, then
 * removed_unpaid, then achieved_net — because one net figure hides which of
 * the two happened, and the salesman most needs to see the second.
 */

const { money } = require('./workflow');

/**
 * The achievement slabs (section 9).
 *
 * "101% and above → 110% of the base incentive (this is the maximum)." The
 * ceiling is why this is a step ladder and not a proportion: a salesman at
 * 300% of target earns 110%, the same as one at 101%.
 */
const SLABS = [
  { from: 1.01, factor: 1.1, label: '101%+' },
  { from: 1.00, factor: 1.0, label: '100%' },
  { from: 0.90, factor: 0.8, label: '90–99%' },
  { from: 0, factor: 0, label: 'below 90%' },
];

/** How long an invoice may stay unpaid before its sale stops counting. */
const PAYMENT_WINDOW_DAYS = 60;

function slabFor(achievedPct) {
  return SLABS.find((s) => achievedPct >= s.from) || SLABS[SLABS.length - 1];
}

/**
 * One salesman-month.
 *
 * Achievement is measured on INVOICES, not orders: an order is a proposal
 * until Gaurav bills it, and section 9 speaks throughout of the sale and the
 * invoice being paid. Cancelled invoices are excluded.
 *
 * `employeeIds` is a list so the showroom pool can be computed as one figure
 * across Pulen and Prabal and then split — "The total earned incentive is
 * split equally between the two."
 */
async function computePeriod(conn, { employeeIds, period, isShowroom = false }) {
  const [year, month] = period.split('-');
  const from = `${year}-${month}-01`;
  // The first of the next month, so the range is half-open and a sale at
  // 23:59 on the 31st is not lost to a BETWEEN on the last day.
  const to = new Date(Date.UTC(Number(year), Number(month), 1)).toISOString().slice(0, 10);

  const [segments] = await conn.query(
    'SELECT * FROM incentive_segments WHERE is_active = TRUE ORDER BY seq',
  );

  // Sold, per segment: the net value of the line, before GST. Incentive is on
  // the business the salesman brought, not on the tax collected with it.
  //
  // The salesman is orders.salesman_id, not created_by: an order raised at the
  // counter for a party tagged to Monu is Monu's sale, which is the whole
  // reason the party carries a permanent salesman tag.
  const [sold] = await conn.query(
    `SELECT i.incentive_segment_id AS segment_id,
            SUM(oi.total - oi.gst_amount) AS value,
            SUM(oi.qty) AS quantity,
            inv.id AS invoice_id,
            inv.grand_total, inv.amount_paid, inv.invoice_date, inv.settled_on
       FROM invoices inv
       JOIN orders o        ON o.order_id = inv.order_id
       JOIN order_items oi  ON oi.order_id = o.order_id
       JOIN items i         ON i.masterid = oi.item_id
      WHERE o.salesman_id IN (?)
        AND inv.status <> 'cancelled'
        AND inv.invoice_date >= ? AND inv.invoice_date < ?
      GROUP BY i.incentive_segment_id, inv.id`,
    [employeeIds, from, to],
  );

  const today = new Date();
  const byId = new Map();

  for (const row of sold) {
    const segId = row.segment_id;
    if (!segId) continue;
    const seg = segments.find((s) => s.id === segId);
    if (!seg) continue;

    if (!byId.has(segId)) byId.set(segId, { gross: 0, removed: 0, qty: 0 });
    const acc = byId.get(segId);

    const measure = seg.target_kind === 'qty' ? Number(row.quantity) : money(row.value);
    acc.gross = money(acc.gross + measure);
    acc.qty += Number(row.quantity);

    // R-19. An invoice settled inside the window keeps its sale. One still
    // open past 60 days loses it. One still open but younger than 60 days is
    // left in — it may yet be paid, and the projection has to show what is at
    // risk rather than write it off early.
    const ageDays = Math.floor(
      (today - new Date(`${String(row.invoice_date).slice(0, 10)}T00:00:00Z`)) / 86400000,
    );
    const settledLate = row.settled_on
      && Math.floor((new Date(`${String(row.settled_on).slice(0, 10)}T00:00:00Z`)
        - new Date(`${String(row.invoice_date).slice(0, 10)}T00:00:00Z`)) / 86400000) > PAYMENT_WINDOW_DAYS;
    const openTooLong = !row.settled_on && ageDays > PAYMENT_WINDOW_DAYS;

    if (settledLate || openTooLong) acc.removed = money(acc.removed + measure);
  }

  const lines = [];
  let gross = 0;

  for (const seg of segments) {
    const acc = byId.get(seg.id) || { gross: 0, removed: 0 };
    const multiplier = isShowroom ? Number(seg.showroom_multiplier) : 1;
    const target = money(Number(seg.monthly_target) * multiplier);
    const net = money(acc.gross - acc.removed);
    const pct = target > 0 ? net / target : 0;
    const slab = slabFor(pct);
    const base = Number(seg.base_incentive);
    const payout = money(base * slab.factor);

    gross = money(gross + payout);
    lines.push({
      segment_id: seg.id,
      segment_name: seg.name,
      target_kind: seg.target_kind,
      target,
      achieved_gross: acc.gross,
      removed_unpaid: acc.removed,
      achieved_net: net,
      achieved_pct: Number((pct * 100).toFixed(4)),
      base_incentive: base,
      payout_factor: slab.factor,
      slab_label: slab.label,
      payout,
    });
  }

  // The showroom pool is earned jointly and halved; a field salesman keeps all
  // of theirs.
  const share = isShowroom && employeeIds.length > 1 ? 1 / employeeIds.length : 1;

  return {
    period,
    is_showroom: isShowroom,
    employee_ids: employeeIds,
    gross_payout: gross,
    share_pct: Number(share.toFixed(4)),
    net_payout: money(gross * share),
    lines,
  };
}

/**
 * Write a computed period to the tables.
 *
 * Only ever writes a draft. R-18 — "No incentive advance is permitted without
 * Yash's explicit approval within the application" — is why approval is a
 * separate route and why an approved period is not recomputed: once approved
 * the figures are what somebody is owed.
 */
async function savePeriod(conn, { employeeId, period, computed }) {
  const [[existing]] = await conn.query(
    'SELECT id, status FROM incentive_periods WHERE employee_id = ? AND period = ?',
    [employeeId, period],
  );
  if (existing && existing.status !== 'draft') {
    const err = new Error(`The ${period} incentive for this salesman is already ${existing.status}.`);
    err.code = 'PERIOD_LOCKED';
    throw err;
  }

  let periodId = existing?.id;
  if (periodId) {
    await conn.query(
      `UPDATE incentive_periods
          SET gross_payout = ?, share_pct = ?, net_payout = ?, is_showroom = ?, computed_at = NOW()
        WHERE id = ?`,
      [computed.gross_payout, computed.share_pct, computed.net_payout, computed.is_showroom, periodId],
    );
    await conn.query('DELETE FROM incentive_lines WHERE period_id = ?', [periodId]);
  } else {
    const [res] = await conn.query(
      `INSERT INTO incentive_periods
         (employee_id, period, is_showroom, gross_payout, share_pct, net_payout, status, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', NOW())`,
      [employeeId, period, computed.is_showroom, computed.gross_payout,
        computed.share_pct, computed.net_payout],
    );
    periodId = res.insertId;
  }

  for (const l of computed.lines) {
    await conn.query(
      `INSERT INTO incentive_lines
         (period_id, segment_id, target, achieved_gross, removed_unpaid, achieved_net,
          achieved_pct, base_incentive, payout_factor, payout)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [periodId, l.segment_id, l.target, l.achieved_gross, l.removed_unpaid,
        l.achieved_net, l.achieved_pct, l.base_incentive, l.payout_factor, l.payout],
    );
  }

  return periodId;
}

module.exports = { SLABS, PAYMENT_WINDOW_DAYS, slabFor, computePeriod, savePeriod };
