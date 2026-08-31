/**
 * KL Utsav, and the dealer growth schemes.
 *
 * Sources: KL_App_Requirements_FINAL.pdf 3.2, and the Lemac developer sheet's
 * 'Discount & Scheme Reference'. Rule R-22.
 *
 * Qualifying value accrues to a MEMBER, never to a customer or an agent
 * directly — the same electrician buys for his own stock one week and refers a
 * customer the next, and R-22 is the rule that says those two must not both
 * fire on one transaction. Membership therefore has its own identity, with
 * optional links to both roles.
 *
 * `scheme_members.qualifying_total` is a cache of `scheme_ledger`, exactly
 * like items.qty is a cache of stock_movements. This module is its only
 * writer, and every write happens inside the caller's transaction.
 */

const { money } = require('./workflow');

/**
 * Qualifying value moves when the order is BILLED, not when it is raised.
 *
 * "This qualifying value is added to the member's cumulative total after the
 * order is billed." An order can still be rejected, short-picked or cancelled;
 * crediting at order time would award a mixer grinder for goods that never
 * left the godown.
 */
async function creditPurchase(conn, { memberId, orderId, invoiceId, amount, note = null }) {
  if (!memberId || !(Number(amount) > 0)) return null;

  const [[member]] = await conn.query(
    'SELECT id, scheme_id, name FROM scheme_members WHERE id = ? FOR UPDATE',
    [memberId],
  );
  if (!member) return null;

  await conn.query(
    `INSERT INTO scheme_ledger (scheme_id, agent_id, member_id, order_id, invoice_id, qty, earned, source, note)
     VALUES (?, NULL, ?, ?, ?, 0, ?, 'purchase', ?)`,
    [member.scheme_id, memberId, orderId, invoiceId, money(amount), note],
  );
  return recomputeMember(conn, memberId);
}

/**
 * Referral bonus (3.2).
 *
 * "If an existing scheme member refers a new member, both the referring member
 * and the new member receive Rs.5,000 added to their qualifying value."
 *
 * Written once, at registration, as two ledger rows with source 'referral'.
 * The uniqueness that stops it being paid twice is that a member is registered
 * once — `referred_by` is set on insert and never edited.
 */
async function creditReferral(conn, { newMemberId, referrerId, bonus }) {
  if (!referrerId || !(Number(bonus) > 0)) return;

  const [[newMember]] = await conn.query(
    'SELECT scheme_id FROM scheme_members WHERE id = ?', [newMemberId]);
  const [[referrer]] = await conn.query(
    'SELECT scheme_id, name FROM scheme_members WHERE id = ?', [referrerId]);
  if (!newMember || !referrer) return;
  // A referral only counts within one scheme; crediting across two would let a
  // lapsed scheme's members inflate the live one.
  if (newMember.scheme_id !== referrer.scheme_id) return;

  for (const [id, label] of [[newMemberId, 'Referred member bonus'], [referrerId, 'Referral bonus']]) {
    await conn.query(
      `INSERT INTO scheme_ledger (scheme_id, agent_id, member_id, qty, earned, source, note)
       VALUES (?, NULL, ?, 0, ?, 'referral', ?)`,
      [newMember.scheme_id, id, money(bonus), label],
    );
    await recomputeMember(conn, id);
  }
}

/**
 * Rebuild a member's total from the ledger and re-evaluate which slab they
 * have reached.
 *
 * "Only the highest slab reached is rewarded. Gifts are not cumulative."
 * So the award is a single slab id, recomputed rather than accumulated — a
 * member who crosses three slabs in one invoice gets the third, not all three.
 */
async function recomputeMember(conn, memberId) {
  const [[sum]] = await conn.query(
    'SELECT COALESCE(SUM(earned), 0) AS total FROM scheme_ledger WHERE member_id = ?',
    [memberId],
  );
  const total = money(sum.total);

  const [[member]] = await conn.query(
    'SELECT id, scheme_id, is_early_bird FROM scheme_members WHERE id = ?', [memberId]);
  if (!member) return null;

  const slab = await slabFor(conn, member.scheme_id, total, member.is_early_bird);

  await conn.query(
    'UPDATE scheme_members SET qualifying_total = ?, awarded_slab_id = ? WHERE id = ?',
    [total, slab ? slab.id : null, memberId],
  );
  return { total, slab };
}

/**
 * The slab a total has reached, with the Early Bird upgrade applied.
 *
 * "If the member registered and made their first purchase within 30 days of
 * the scheme launch, they receive a one-slab upgrade on their final reward."
 * The upgrade is one rung up the ladder from whatever they earned — not a
 * bonus applied to the value, which would compound with itself as they buy
 * more.
 */
async function slabFor(conn, schemeId, total, isEarlyBird) {
  const [slabs] = await conn.query(
    `SELECT id, slab_order, min_value, reward_gift, reward_percent, reward_note
       FROM scheme_slabs WHERE scheme_id = ? AND min_value IS NOT NULL
      ORDER BY min_value ASC`,
    [schemeId],
  );
  if (!slabs.length) return null;

  let index = -1;
  for (let i = 0; i < slabs.length; i += 1) {
    if (Number(total) >= Number(slabs[i].min_value)) index = i;
  }
  if (index < 0) return null;

  // The upgrade cannot go past the top rung; someone already on the air
  // conditioner has nothing above it to be upgraded to.
  if (isEarlyBird && index < slabs.length - 1) index += 1;
  return slabs[index];
}

/**
 * What the member sees: where they are, and what the next rung is worth.
 *
 * The gap to the next slab is the number that changes behaviour — an
 * electrician on 34,000 needs to see that 50,000 earns a mixer grinder, not
 * merely that they have spent 34,000.
 */
async function standing(conn, memberId) {
  const [[member]] = await conn.query(
    `SELECT m.*, s.name AS scheme_name, s.ends_on, s.early_bird_days, s.starts_on
       FROM scheme_members m JOIN schemes s ON s.id = m.scheme_id
      WHERE m.id = ?`,
    [memberId],
  );
  if (!member) return null;

  const [slabs] = await conn.query(
    `SELECT id, min_value, reward_gift, reward_note FROM scheme_slabs
      WHERE scheme_id = ? AND min_value IS NOT NULL ORDER BY min_value ASC`,
    [member.scheme_id],
  );

  const total = Number(member.qualifying_total);
  const reached = slabs.filter((s) => total >= Number(s.min_value));
  const next = slabs.find((s) => total < Number(s.min_value)) || null;
  const awarded = slabs.find((s) => s.id === member.awarded_slab_id) || null;

  return {
    member,
    total,
    slabs: slabs.map((s) => ({ ...s, reached: total >= Number(s.min_value) })),
    reached_count: reached.length,
    awarded,
    next: next ? { ...next, gap: money(Number(next.min_value) - total) } : null,
  };
}

/**
 * Is this registration inside the Early Bird window? (3.2)
 * Measured from the scheme's launch date, not from today.
 */
function isEarlyBird(scheme, registeredOn) {
  const start = new Date(`${String(scheme.starts_on).slice(0, 10)}T00:00:00Z`);
  const reg = new Date(`${String(registeredOn).slice(0, 10)}T00:00:00Z`);
  const days = Math.floor((reg - start) / 86400000);
  return days >= 0 && days < Number(scheme.early_bird_days || 30);
}

module.exports = {
  creditPurchase,
  creditReferral,
  recomputeMember,
  slabFor,
  standing,
  isEarlyBird,
};
