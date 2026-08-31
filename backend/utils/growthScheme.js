/**
 * Dealer growth schemes — the Lemac regime.
 *
 * Source: LEMAC_Developer_Master_v7.xlsx, sheet 'Discount & Scheme Reference'.
 *
 * A different shape from KL Utsav, and the difference is what this file exists
 * for:
 *
 *   KL Utsav (utils/scheme.js)  accrues to a PERSON, cumulatively, over one
 *                               90-day window, and pays a physical gift at the
 *                               highest rung reached. Never resets.
 *
 *   Growth (here)               accrues to a DEALER, per window, RESETS each
 *                               window, and pays a PERCENTAGE of what they
 *                               billed.
 *
 * Two rules from the sheet do most of the work:
 *
 *   "STACK: Monthly credit (4%) + Quarterly gift (5%) + Yearly credit (3%) are
 *    ADDITIVE (separate layers)... Each is earned independently on its own
 *    billing."
 *      One award row per (scheme, dealer, window). Nothing nets them against
 *      each other, and a dealer can be at the top rung of all three at once —
 *      which the sheet says reaches 12% together.
 *
 *   "All credit notes / gifts are computed on the NET PRE-GST value (Billing =
 *    List Price less 52%). Released only after full payment of the goods."
 *      Accrual is on the net line value, before GST. And EARNED and RELEASED
 *      are two different moments: the slab is reached on billing, the money is
 *      payable only once the invoices behind it are settled.
 *
 * `scheme_growth_awards.qualifying` is a cache of `scheme_ledger`, on exactly
 * the terms `items.qty` is a cache of `stock_movements`. This module is its
 * only writer.
 */

const { money, nextDocNumber, recomputeBalance, notify } = require('./workflow');

/**
 * Which per-item flag gates each kind of growth scheme.
 *
 * The sheet makes scheme validity a property of the ITEM — "Scheme validity
 * (Yes/No) is a product-level property; app reads the flag, then applies the
 * dealer slab" — so `schemes.item_flag` names the column and this is the
 * allow-list that keeps a scheme from being pointed at an arbitrary one.
 */
const ITEM_FLAGS = [
  'sch_modular_monthly',
  'sch_modular_quarterly',
  'sch_modular_yearly',
  'sch_boxes_monthly',
  'sch_dream_monthly',
];

/**
 * The window a date falls in for a scheme.
 *
 * A renewing scheme's window is the calendar month — the sheet says "renews
 * monthly" for the two monthly ones. A non-renewing scheme's window is its own
 * start and end, because the sheet gives those fixed dates: "Modular Quarterly
 * (Puja Bonanza) | 1 September 2026 – 30 November 2026 (three months)".
 */
function windowFor(scheme, onDate) {
  const day = String(onDate).slice(0, 10);

  if (!scheme.renews) {
    return {
      key: String(scheme.starts_on).slice(0, 10),
      from: String(scheme.starts_on).slice(0, 10),
      to: String(scheme.ends_on).slice(0, 10),
    };
  }

  const [year, month] = day.split('-').map(Number);
  // Last day of the month, via day 0 of the next — no month-length table, and
  // February is right in a leap year without anybody remembering.
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const key = `${year}-${String(month).padStart(2, '0')}`;
  return { key, from: `${key}-01`, to: `${key}-${String(last).padStart(2, '0')}` };
}

/** The live growth schemes covering a date. */
async function activeSchemes(conn, onDate) {
  const day = String(onDate).slice(0, 10);
  const [rows] = await conn.query(
    `SELECT * FROM schemes
      WHERE kind IN ('growth_credit','growth_gift') AND is_active = TRUE
        AND starts_on <= ? AND ends_on >= ?
      ORDER BY id`, [day, day]);
  // A scheme whose item_flag is not a real column would make every accrual
  // query fail; refused here rather than interpolated into SQL.
  return rows.filter((s) => !s.item_flag || ITEM_FLAGS.includes(s.item_flag));
}

/**
 * Credit an invoice to every growth scheme it qualifies for.
 *
 * Called from the invoice transaction, after the lines exist. Returns what was
 * credited, for the response.
 *
 * Only DEALERS accrue: the sheet's slabs are dealer billing figures, and the
 * discount ladder they sit on is "List less 52%", which is the dealer column.
 * A retail or builder sale is not dealer billing.
 */
async function creditInvoice(conn, { invoiceId, customerId, customerType, invoiceDate }) {
  if (customerType !== 'dealer') return [];

  const schemes = await activeSchemes(conn, invoiceDate);
  if (!schemes.length) return [];

  const credited = [];

  for (const scheme of schemes) {
    // The qualifying value: net of GST, and only the lines whose item carries
    // this scheme's flag. `modular_weightage` is the sheet's own per-item
    // weighting ("Acrylic Glass Plates = 100% | all modular-valid = 100% |
    // non-modular = not counted") — read rather than assumed, the same
    // discipline the KL Utsav weighting follows.
    const flag = scheme.item_flag;
    const [[sum]] = await conn.query(
      `SELECT COALESCE(SUM(
                (ii.total - ii.gst_amount) * COALESCE(i.modular_weightage, 1)
              ), 0) AS qualifying
         FROM invoice_items ii
         JOIN items i ON i.masterid = ii.item_id
        WHERE ii.invoice_id = ?
          ${flag ? `AND i.${flag} = TRUE` : ''}`,
      [invoiceId]);

    const qualifying = money(sum.qualifying);
    if (qualifying <= 0) continue;

    const win = windowFor(scheme, invoiceDate);

    await conn.query(
      `INSERT INTO scheme_ledger
         (scheme_id, agent_id, member_id, customer_id, window_key, invoice_id,
          qty, earned, source, note)
       VALUES (?, NULL, NULL, ?, ?, ?, 0, ?, 'growth', ?)`,
      [scheme.id, customerId, win.key, invoiceId, qualifying,
        `${scheme.name} ${win.key}`]);

    const award = await recompute(conn, {
      schemeId: scheme.id, customerId, window: win, scheme });

    credited.push({
      scheme: scheme.name,
      window: win.key,
      added: qualifying,
      total: award.qualifying,
      slab: award.reward_percent,
      reward: award.reward_amount,
      status: award.status,
    });
  }

  return credited;
}

/**
 * Rebuild one dealer's standing in one window from the ledger, and re-evaluate
 * the slab.
 *
 * The slab is the HIGHEST rung reached, as with KL Utsav — but here it pays a
 * percentage of the whole qualifying figure rather than a fixed gift, so the
 * reward moves every time the dealer bills again.
 */
async function recompute(conn, { schemeId, customerId, window, scheme }) {
  const [[sum]] = await conn.query(
    `SELECT COALESCE(SUM(earned), 0) AS total FROM scheme_ledger
      WHERE scheme_id = ? AND customer_id = ? AND window_key = ? AND source = 'growth'`,
    [schemeId, customerId, window.key]);
  const qualifying = money(sum.total);

  const [slabs] = await conn.query(
    `SELECT * FROM scheme_slabs WHERE scheme_id = ? AND min_value IS NOT NULL
      ORDER BY min_value ASC`, [schemeId]);

  let reached = null;
  for (const slab of slabs) {
    if (qualifying >= Number(slab.min_value)) reached = slab;
  }

  const percent = reached && reached.reward_percent !== null
    ? Number(reached.reward_percent) : null;
  const reward = percent !== null ? money(qualifying * percent) : 0;

  // 'accruing' until a slab is reached, then 'earned'. Release is a separate
  // step because it depends on payment, not on billing.
  const status = reached ? 'earned' : 'accruing';

  await conn.query(
    `INSERT INTO scheme_growth_awards
       (scheme_id, customer_id, window_key, window_from, window_to,
        qualifying, slab_id, reward_percent, reward_amount, reward_gift, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       qualifying = VALUES(qualifying),
       slab_id = VALUES(slab_id),
       reward_percent = VALUES(reward_percent),
       reward_amount = VALUES(reward_amount),
       reward_gift = VALUES(reward_gift),
       -- An award already released or issued is not dragged back to 'earned' by
       -- a later invoice in the same window: the money has gone out, and the
       -- next billing belongs to whatever comes after it.
       status = CASE WHEN scheme_growth_awards.status IN ('released','issued')
                     THEN scheme_growth_awards.status ELSE VALUES(status) END`,
    [schemeId, customerId, window.key, window.from, window.to,
      qualifying, reached ? reached.id : null, percent, reward,
      reached ? reached.reward_gift : null, status]);

  const [[award]] = await conn.query(
    `SELECT * FROM scheme_growth_awards
      WHERE scheme_id = ? AND customer_id = ? AND window_key = ?`,
    [schemeId, customerId, window.key]);
  return award;
}

/**
 * How much of a window's qualifying billing has actually been paid for.
 *
 * "Released only after full payment of the goods." Measured against the
 * invoices that produced the accrual, using `invoices.settled_on` — which is
 * maintained by the FIFO allocator, so this is the same notion of "paid" the
 * cash discount and the incentive rule use.
 */
async function paidPortion(conn, { schemeId, customerId, windowKey }) {
  const [[row]] = await conn.query(
    `SELECT COALESCE(SUM(CASE WHEN i.settled_on IS NOT NULL THEN l.earned END), 0) AS paid,
            COALESCE(SUM(l.earned), 0) AS total
       FROM scheme_ledger l
       JOIN invoices i ON i.id = l.invoice_id
      WHERE l.scheme_id = ? AND l.customer_id = ? AND l.window_key = ?
        AND l.source = 'growth'`,
    [schemeId, customerId, windowKey]);
  return { paid: money(row.paid), total: money(row.total) };
}

/**
 * Release the awards whose window has closed and whose goods are paid for.
 *
 * Run by the alert sweep. Two conditions, both from the sheet: the window is
 * over (a monthly scheme's slab cannot be known until the month ends, because
 * one more invoice could lift the dealer a rung), and the billing behind it has
 * been settled.
 *
 * A window that closed with nothing reached is marked 'lapsed' rather than left
 * accruing for ever — otherwise the standings screen fills with dealers who
 * bought once in March.
 */
async function releaseDue(conn, today) {
  const day = String(today).slice(0, 10);

  const [awards] = await conn.query(
    `SELECT a.*, s.name AS scheme_name, s.kind, s.requires_payment, c.name AS party
       FROM scheme_growth_awards a
       JOIN schemes s   ON s.id = a.scheme_id
       JOIN customers c ON c.masterid = a.customer_id
      WHERE a.window_to < ? AND a.status IN ('accruing','earned')`,
    [day]);

  const released = [];
  const lapsed = [];

  for (const award of awards) {
    if (award.status === 'accruing') {
      await conn.query(
        "UPDATE scheme_growth_awards SET status = 'lapsed' WHERE id = ?", [award.id]);
      lapsed.push(award.id);
      continue;
    }

    const { paid, total } = await paidPortion(conn, {
      schemeId: award.scheme_id,
      customerId: award.customer_id,
      windowKey: award.window_key,
    });

    // "Released only after full payment of the goods" — full, so a partially
    // settled window waits. The figure is kept on the award either way, so the
    // dealer can be shown what is holding it up.
    await conn.query(
      'UPDATE scheme_growth_awards SET paid_qualifying = ? WHERE id = ?',
      [paid, award.id]);

    if (award.requires_payment && paid < total - 0.01) continue;

    await conn.query(
      "UPDATE scheme_growth_awards SET status = 'released', released_at = NOW() WHERE id = ?",
      [award.id]);
    released.push({
      id: award.id,
      party: award.party,
      scheme: award.scheme_name,
      window: award.window_key,
      reward: Number(award.reward_amount),
      kind: award.kind,
    });
  }

  return { released, lapsed };
}

/**
 * Turn a released award into a credit note.
 *
 * Only for `growth_credit`. The quarterly scheme is `growth_gift` — "GIFT item
 * (electronics / daily-use)" — and a gift is handed over, not posted to a
 * ledger, so it is marked issued without a note.
 *
 * Raised as `pending`, like every other credit note: it moves the party's
 * balance when an owner issues it, which is the standing invariant.
 */
async function issueAward(conn, { awardId, actorId }) {
  const [[award]] = await conn.query(
    `SELECT a.*, s.name AS scheme_name, s.kind, c.name AS party
       FROM scheme_growth_awards a
       JOIN schemes s ON s.id = a.scheme_id
       JOIN customers c ON c.masterid = a.customer_id
      WHERE a.id = ? FOR UPDATE`, [awardId]);

  if (!award) return { error: 'No such award.', code: 'NOT_FOUND' };
  if (award.status === 'issued') {
    return { error: 'That award has already been issued.', code: 'ALREADY_ISSUED' };
  }
  if (award.status !== 'released') {
    return {
      error: `That award is ${award.status}. It is issued once the window closes `
        + 'and the goods are paid for.',
      code: 'NOT_RELEASED',
    };
  }

  if (award.kind === 'growth_gift') {
    await conn.query(
      `UPDATE scheme_growth_awards
          SET status = 'issued', issued_at = NOW(), issued_by = ?,
              note = CONCAT(COALESCE(note,''), ' | gift handed over')
        WHERE id = ?`, [actorId, award.id]);
    return { gift: award.reward_gift, party: award.party, credit_note_id: null };
  }

  if (!(Number(award.reward_amount) > 0)) {
    return { error: 'That award is worth nothing to issue.', code: 'NO_REWARD' };
  }

  const noteNo = await nextDocNumber(conn, {
    table: 'credit_notes', column: 'note_no', prefix: 'GS-', width: 5,
  });

  const [ins] = await conn.query(
    `INSERT INTO credit_notes
       (note_no, customer_id, invoice_id, return_id, amount, reason, origin,
        status, note_date, issued_by)
     VALUES (?, ?, NULL, NULL, ?, ?, 'manual', 'pending', CURDATE(), ?)`,
    [noteNo, award.customer_id, money(award.reward_amount),
      `${award.scheme_name} ${award.window_key}: `
      + `${(Number(award.reward_percent) * 100).toFixed(2)}% of ${Number(award.qualifying).toFixed(2)}`,
      actorId]);

  await conn.query(
    `UPDATE scheme_growth_awards
        SET status = 'issued', issued_at = NOW(), issued_by = ?, credit_note_id = ?
      WHERE id = ?`, [actorId, ins.insertId, award.id]);

  await recomputeBalance(conn, award.customer_id);

  await notify(conn, {
    userId: null,
    tone: 'info',
    title: `Growth scheme credit ${noteNo}`,
    body: `${award.party} earned ${Number(award.reward_amount).toFixed(2)} on `
      + `${award.scheme_name} ${award.window_key}. Approve to post it.`,
    actor: actorId,
    refType: 'credit_note',
    refId: ins.insertId,
  });

  return { credit_note_id: ins.insertId, note_no: noteNo, amount: money(award.reward_amount) };
}

/** A dealer's standing across every live growth scheme, for the screen. */
async function standing(conn, customerId, onDate) {
  const schemes = await activeSchemes(conn, onDate);
  const out = [];

  for (const scheme of schemes) {
    const win = windowFor(scheme, onDate);
    const [[award]] = await conn.query(
      `SELECT * FROM scheme_growth_awards
        WHERE scheme_id = ? AND customer_id = ? AND window_key = ?`,
      [scheme.id, customerId, win.key]);
    const [slabs] = await conn.query(
      `SELECT * FROM scheme_slabs WHERE scheme_id = ? AND min_value IS NOT NULL
        ORDER BY min_value ASC`, [scheme.id]);

    const qualifying = award ? Number(award.qualifying) : 0;
    const next = slabs.find((s) => qualifying < Number(s.min_value)) || null;

    out.push({
      scheme_id: scheme.id,
      scheme: scheme.name,
      kind: scheme.kind,
      period: scheme.period,
      window: win,
      qualifying,
      reward_percent: award ? award.reward_percent : null,
      reward_amount: award ? Number(award.reward_amount) : 0,
      reward_gift: award ? award.reward_gift : null,
      status: award ? award.status : 'accruing',
      slabs: slabs.map((s) => ({
        min_value: Number(s.min_value),
        percent: s.reward_percent === null ? null : Number(s.reward_percent),
        gift: s.reward_gift,
        reached: qualifying >= Number(s.min_value),
      })),
      // The gap to the next rung is the number that changes behaviour, exactly
      // as it is for the electrician scheme.
      next: next ? {
        min_value: Number(next.min_value),
        percent: next.reward_percent === null ? null : Number(next.reward_percent),
        gap: money(Number(next.min_value) - qualifying),
      } : null,
    });
  }

  return out;
}

module.exports = {
  ITEM_FLAGS,
  windowFor,
  activeSchemes,
  creditInvoice,
  recompute,
  paidPortion,
  releaseDue,
  issueAward,
  standing,
};
