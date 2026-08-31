const express = require('express');

const router = express.Router();
const pool = require('../config/db');
const { authenticate, requirePermission } = require('../middleware/auth');
const { numericId } = require('../middleware/params');
const { creditReferral, recomputeMember, standing, isEarlyBird } = require('../utils/scheme');
const {
  standing: growthStanding, issueAward: issueGrowthAward,
} = require('../utils/growthScheme');
const { businessDay } = require('../utils/businessDay');

router.use(authenticate);
numericId(router);

/**
 * KL Utsav membership.
 *
 * Source: KL_App_Requirements_FINAL.pdf 3.2.
 *
 * The registration window opens automatically when the customer type is
 * Electrician Direct, and the salesman is standing at a counter with the
 * electrician in front of him — so `POST /members` is a one-tap registration
 * that takes a name and a phone number and nothing else mandatory.
 *
 * Phone is the identity. It is what the search asks for ("The user searches
 * for the agent by phone number"), it is what the business actually knows
 * about an electrician, and it is the unique key within a scheme.
 */

/** GET /api/schemes — the live schemes. */
router.get('/', requirePermission('schemes.view'), async (req, res, next) => {
  try {
    const [schemes] = await pool.query(
      `SELECT s.*, (SELECT COUNT(*) FROM scheme_members m WHERE m.scheme_id = s.id) AS members
         FROM schemes s WHERE s.is_active = TRUE ORDER BY s.starts_on DESC`);
    for (const s of schemes) {
      const [slabs] = await pool.query(
        'SELECT * FROM scheme_slabs WHERE scheme_id = ? ORDER BY slab_order, min_value', [s.id]);
      s.slabs = slabs;
    }
    res.json({ schemes });
  } catch (err) { next(err); }
});

/**
 * GET /api/schemes/members?phone=… — the registration check.
 *
 * "The application checks whether this electrician is already registered in
 * the KL Utsav Scheme. If not registered: the user is offered a one-tap
 * registration option during this order."
 *
 * Returns `{ member: null }` rather than a 404 for an unknown number: not
 * being registered is the ordinary case and the expected answer, not an error.
 */
router.get('/members', requirePermission('schemes.view'), async (req, res, next) => {
  try {
    const phone = String(req.query.phone || '').trim();
    if (phone) {
      const [[member]] = await pool.query(
        `SELECT m.*, s.name AS scheme_name FROM scheme_members m
           JOIN schemes s ON s.id = m.scheme_id
          WHERE m.phone = ? AND s.is_active = TRUE LIMIT 1`, [phone]);
      if (!member) return res.json({ member: null, registered: false });
      return res.json({ member, registered: true, ...(await standing(pool, member.id)) });
    }

    const [members] = await pool.query(
      `SELECT m.*, s.name AS scheme_name FROM scheme_members m
         JOIN schemes s ON s.id = m.scheme_id
        WHERE s.is_active = TRUE
        ORDER BY m.qualifying_total DESC LIMIT 200`);
    res.json({ members });
  } catch (err) { next(err); }
});

/** POST /api/schemes/members — one-tap registration during an order. */
router.post('/members', requirePermission('schemes.create'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const { name, phone, profession, area, customer_id, agent_id, referred_by_phone } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'A name is required.' });
    if (!phone || !String(phone).trim()) return res.status(400).json({ error: 'A phone number is required.' });

    await conn.beginTransaction();

    const [[scheme]] = await conn.query(
      `SELECT * FROM schemes WHERE kind = 'electrician_gift' AND is_active = TRUE
        ORDER BY starts_on DESC LIMIT 1`);
    if (!scheme) {
      await conn.rollback();
      return res.status(409).json({
        error: 'No electrician scheme is running at the moment.', code: 'NO_LIVE_SCHEME' });
    }

    const today = new Date().toISOString().slice(0, 10);

    // "If the registration falls within the first 30 days of the scheme launch,
    // the system tags this member as an Early Bird automatically." Decided
    // here, from the scheme's own launch date, and never editable — it is a
    // one-slab upgrade on the final reward and a settable flag would be worth
    // money to anyone who could set it.
    const earlyBird = isEarlyBird(scheme, today);

    let referrer = null;
    if (referred_by_phone) {
      const [[r]] = await conn.query(
        'SELECT id FROM scheme_members WHERE scheme_id = ? AND phone = ?',
        [scheme.id, String(referred_by_phone).trim()]);
      referrer = r?.id || null;
    }

    const [ins] = await conn.query(
      `INSERT INTO scheme_members
         (scheme_id, name, phone, profession, area, customer_id, agent_id,
          registered_on, is_early_bird, referred_by, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [scheme.id, String(name).trim(), String(phone).trim(), profession || null,
        area || null, customer_id || null, agent_id || null, today,
        earlyBird, referrer, req.user.id]);

    // "If an existing scheme member refers a new member, both the referring
    // member and the new member receive Rs.5,000 added to their qualifying
    // value." Written as two ledger rows so the bonus is visible as a bonus,
    // not folded into a purchase total nobody can account for.
    if (referrer) {
      await creditReferral(conn, {
        newMemberId: ins.insertId, referrerId: referrer, bonus: scheme.referral_bonus });
    } else {
      await recomputeMember(conn, ins.insertId);
    }

    await conn.commit();
    res.status(201).json({
      message: 'Registered for the scheme.',
      id: ins.insertId,
      is_early_bird: earlyBird,
      referral_bonus: referrer ? Number(scheme.referral_bonus) : 0,
    });
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        error: 'That phone number is already registered on this scheme.', code: 'ALREADY_REGISTERED' });
    }
    next(err);
  } finally { conn.release(); }
});

/**
 * GET /api/schemes/members/:id — where a member stands.
 *
 * The gap to the next slab is what the screen leads on: an electrician on
 * 34,000 needs to see that 50,000 earns a mixer grinder, not merely what they
 * have spent.
 */
router.get('/members/:id', requirePermission('schemes.view'), async (req, res, next) => {
  try {
    const s = await standing(pool, req.params.id);
    if (!s) return res.status(404).json({ error: 'Member not found' });

    const [ledger] = await pool.query(
      `SELECT l.*, i.invoice_no FROM scheme_ledger l
         LEFT JOIN invoices i ON i.id = l.invoice_id
        WHERE l.member_id = ? ORDER BY l.id DESC LIMIT 50`, [req.params.id]);
    res.json({ ...s, ledger });
  } catch (err) { next(err); }
});

/** GET /api/schemes/standings — the leaderboard the scheme screen draws. */
router.get('/standings', requirePermission('schemes.view'), async (req, res, next) => {
  try {
    const [[scheme]] = await pool.query(
      `SELECT * FROM schemes WHERE kind = 'electrician_gift' AND is_active = TRUE
        ORDER BY starts_on DESC LIMIT 1`);
    if (!scheme) return res.json({ scheme: null, standings: [] });

    const [slabs] = await pool.query(
      'SELECT * FROM scheme_slabs WHERE scheme_id = ? ORDER BY min_value', [scheme.id]);
    const [standings] = await pool.query(
      `SELECT m.id, m.name, m.phone, m.qualifying_total, m.is_early_bird,
              m.awarded_slab_id, b.reward_gift
         FROM scheme_members m
         LEFT JOIN scheme_slabs b ON b.id = m.awarded_slab_id
        WHERE m.scheme_id = ?
        ORDER BY m.qualifying_total DESC LIMIT 100`, [scheme.id]);

    res.json({ scheme, slabs, standings });
  } catch (err) { next(err); }
});

/**
 * The dealer growth schemes — the Lemac regime.
 *
 * Source: LEMAC_Developer_Master_v7.xlsx. These are the one thing in the
 * spreadsheets that KL_App_Requirements_FINAL.pdf never mentions, so they are
 * SEEDED INACTIVE: the engine and the slabs are complete, and nothing accrues
 * until somebody sets `is_active`. Whether K.L. Electricals runs Lemac's dealer
 * schemes as a distributor is a business fact that is not in any of the three
 * documents, and guessing it would start issuing credit notes against a scheme
 * the company may not operate.
 */

/** GET /api/schemes/growth — the live growth schemes and their slabs. */
router.get('/growth', requirePermission('schemes.view'), async (req, res, next) => {
  try {
    const [schemes] = await pool.query(
      `SELECT s.*,
              (SELECT COUNT(DISTINCT a.customer_id) FROM scheme_growth_awards a
                WHERE a.scheme_id = s.id) AS dealers
         FROM schemes s
        WHERE s.kind IN ('growth_credit','growth_gift')
        ORDER BY s.period, s.id`);

    for (const scheme of schemes) {
      const [slabs] = await pool.query(
        `SELECT id, min_value, reward_percent, reward_gift, reward_note
           FROM scheme_slabs WHERE scheme_id = ? AND min_value IS NOT NULL
          ORDER BY min_value`, [scheme.id]);
      scheme.slabs = slabs;
    }

    res.json({
      schemes,
      active: schemes.filter((s) => s.is_active).length,
      // Said in the payload rather than left to be inferred from an empty list.
      note: schemes.some((s) => s.is_active) ? null
        : 'No growth scheme is active. They are seeded inactive because the '
          + 'requirements document does not mention them — activate one to start accruing.',
    });
  } catch (err) { next(err); }
});

/**
 * GET /api/schemes/growth/standing/:customerId — one dealer, every scheme.
 *
 * The gap to the next rung is what the screen leads on: a dealer at 58,000 on
 * the monthly scheme needs to see that 60,000 moves them from 2.5% to 3%.
 */
router.get('/growth/standing/:customerId', requirePermission('schemes.view'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const [[party]] = await conn.query(
      'SELECT masterid, name, customer_type FROM customers WHERE masterid = ?',
      [req.params.customerId]);
    if (!party) return res.status(404).json({ error: 'No such party' });

    res.json({
      party,
      // Only dealers accrue: the slabs are dealer billing figures on the "List
      // less 52%" ladder, which is the dealer column.
      eligible: party.customer_type === 'dealer',
      schemes: await growthStanding(conn, party.masterid, businessDay()),
    });
  } catch (err) { next(err); } finally { conn.release(); }
});

/** GET /api/schemes/growth/:id/standings — the leaderboard for one scheme. */
router.get('/growth/:id/standings', requirePermission('schemes.view'), async (req, res, next) => {
  try {
    const [[scheme]] = await pool.query('SELECT * FROM schemes WHERE id = ?', [req.params.id]);
    if (!scheme) return res.status(404).json({ error: 'No such scheme' });

    const [rows] = await pool.query(
      `SELECT a.*, c.name AS party FROM scheme_growth_awards a
         JOIN customers c ON c.masterid = a.customer_id
        WHERE a.scheme_id = ?
        ORDER BY a.window_key DESC, a.qualifying DESC LIMIT 300`, [req.params.id]);

    res.json({ scheme, standings: rows });
  } catch (err) { next(err); }
});

/**
 * POST /api/schemes/growth/awards/:id/issue — pay it.
 *
 * A `growth_credit` award becomes a PENDING credit note, which moves the
 * party's balance only when an owner issues it — the standing invariant. A
 * `growth_gift` award is marked issued without a note, because a gift is handed
 * over rather than posted to a ledger.
 */
router.post('/growth/awards/:id/issue', requirePermission('schemes.manage'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const out = await issueGrowthAward(conn, {
      awardId: Number(req.params.id), actorId: req.user.id });
    if (out.error) {
      await conn.rollback();
      return res.status(409).json({ error: out.error, code: out.code });
    }
    await conn.commit();
    res.json({ message: out.gift ? `Gift recorded: ${out.gift}` : 'Credit note raised.', ...out });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

/**
 * PUT /api/schemes/:id — roll a scheme's cycle forward.
 *
 * The Lemac sheet asks for this in as many words: "SCHEME VALIDITY DATES
 * (current cycle) ... Note: App should allow validity dates to be updated each
 * cycle." Its own dates are September 2026 onward, and a monthly scheme has to
 * be rolled every month or it silently stops accruing when its end date passes.
 *
 * Only the window and the descriptive fields. The KIND, the PERIOD and the
 * ITEM FLAG are deliberately not editable: changing what a scheme measures
 * while awards exist against it would leave those awards computed on one basis
 * and displayed on another. A different measure is a different scheme.
 */
router.put('/:id', requirePermission('schemes.manage'), async (req, res, next) => {
  try {
    const [[scheme]] = await pool.query('SELECT * FROM schemes WHERE id = ?', [req.params.id]);
    if (!scheme) return res.status(404).json({ error: 'No such scheme' });

    const isDay = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
    const from = req.body?.starts_on ?? null;
    const to = req.body?.ends_on ?? null;

    if (from !== null && !isDay(from)) {
      return res.status(400).json({ error: 'starts_on must be YYYY-MM-DD.', code: 'BAD_DATE' });
    }
    if (to !== null && !isDay(to)) {
      return res.status(400).json({ error: 'ends_on must be YYYY-MM-DD.', code: 'BAD_DATE' });
    }

    const startsOn = from ?? String(scheme.starts_on).slice(0, 10);
    const endsOn = to ?? String(scheme.ends_on).slice(0, 10);
    if (endsOn < startsOn) {
      return res.status(400).json({
        error: 'A scheme cannot end before it starts.', code: 'BAD_WINDOW' });
    }

    // Awards are keyed on the window, and for a non-renewing scheme the window
    // key IS the start date — so moving it would orphan every award already
    // accrued and the dealers would appear to have bought nothing.
    if (!scheme.renews && from !== null && from !== String(scheme.starts_on).slice(0, 10)) {
      const [[existing]] = await pool.query(
        'SELECT COUNT(*) AS n FROM scheme_growth_awards WHERE scheme_id = ?', [scheme.id]);
      if (Number(existing.n) > 0) {
        return res.status(409).json({
          error: `${existing.n} dealer(s) have already accrued in this cycle. `
            + 'Moving its start date would orphan those awards — create the next '
            + 'cycle as a new scheme instead.',
          code: 'CYCLE_IN_USE',
        });
      }
    }

    await pool.query(
      `UPDATE schemes
          SET starts_on = ?, ends_on = ?,
              name = COALESCE(?, name), note = COALESCE(?, note),
              referral_bonus = COALESCE(?, referral_bonus),
              early_bird_days = COALESCE(?, early_bird_days),
              requires_payment = COALESCE(?, requires_payment)
        WHERE id = ?`,
      [startsOn, endsOn,
        req.body?.name ?? null, req.body?.note ?? null,
        req.body?.referral_bonus ?? null, req.body?.early_bird_days ?? null,
        req.body?.requires_payment ?? null,
        scheme.id]);

    const [[updated]] = await pool.query('SELECT * FROM schemes WHERE id = ?', [scheme.id]);
    res.json({ message: 'Cycle updated.', scheme: updated });
  } catch (err) { next(err); }
});

/**
 * POST /api/schemes/:id/activate — switch a scheme on or off.
 *
 * Guarded on `schemes.manage` and deliberately explicit: activating a growth
 * scheme starts accruing money against every dealer invoice, so it should be a
 * decision somebody made rather than a side effect of a seed script.
 */
router.post('/:id/activate', requirePermission('schemes.manage'), async (req, res, next) => {
  try {
    const on = req.body?.active === true || req.body?.active === 'true';
    const [[scheme]] = await pool.query('SELECT * FROM schemes WHERE id = ?', [req.params.id]);
    if (!scheme) return res.status(404).json({ error: 'No such scheme' });

    await pool.query('UPDATE schemes SET is_active = ? WHERE id = ?', [on, scheme.id]);
    res.json({
      message: on
        ? `${scheme.name} is live. Dealer invoices will now accrue against it.`
        : `${scheme.name} is switched off. Accruals already earned are unaffected.`,
      scheme_id: scheme.id,
      is_active: on,
    });
  } catch (err) { next(err); }
});

module.exports = router;
