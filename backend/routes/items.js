const express = require('express');
const router = express.Router();
const XLSX = require('xlsx');
const pool = require('../config/db');
const { authenticate, requirePermission } = require('../middleware/auth');
const { userCan } = require('../utils/permissions');
const { allRates } = require('../utils/pricing');
const { numericId } = require('../middleware/params');
const { notify, usersWhoCan } = require('../utils/workflow');
const { KL_LAYOUT, LEMAC_LAYOUT, importFile } = require('../scripts/import-rates');

router.use(authenticate);

// Rejects a non-numeric :id before any handler binds it into SQL.
numericId(router);

// Columns a caller is allowed to set. Anything else in the body is ignored
// rather than trusted, and — the point of the list — a column the caller did
// NOT send is left alone instead of being overwritten with NULL.
const WRITABLE = [
  'name', 'code', 'brand', 'category', 'hsn', 'gst_percent', 'unit', 'rate',
  'discount', 'is_active', 'min_stock', 'godown', 'rack',
];

/**
 * Columns only the rate-keeper may write. R-04: "Only Gaurav has the ability
 * to edit item rates. The rate edit control is not visible to any other user."
 *
 * Split from WRITABLE rather than guarded inside the handler so that adding a
 * pricing column to one list cannot accidentally make it editable from the
 * other. cost_price is here because it is what R-16's below-cost alert fires
 * against — whoever can set the cost decides when the alarm sounds.
 */
const RATE_WRITABLE = [
  'pricing_type', 'base_price', 'cost_price',
  'disc_dealer', 'disc_builder_direct', 'disc_builder_comm',
  'disc_retail_direct', 'disc_retail_comm', 'disc_electrician',
  'ratio_builder_direct', 'ratio_builder_comm', 'ratio_retail_direct',
  'ratio_retail_comm', 'ratio_electrician',
  'comm_retail_agent', 'comm_builder_agent', 'scheme_weightage',
];

/**
 * R-11 — who may APPROVE a rate adjustment.
 *
 * "Only Yash or Manoj can approve." Both hold the wildcard, so this is the
 * wildcard check and nothing narrower: there is deliberately no grantable
 * `items.rates.approve`, because a rule naming the two owners should not be
 * satisfiable by handing somebody a permission.
 */
const approvesRates = (user) => userCan(user, 'all');

/**
 * Section 3.2, September 2026 — "Selling below the rate — approval slabs".
 * CHANGED FROM v1, which sent every proposed rate to an owner regardless of
 * size. Only a DECREASE to `base_price` is tiered this way; every other
 * pricing field (discount ladders, ratios, commission, cost_price itself)
 * keeps the original owner-only rule, because "below the rate" specifically
 * means the price a party is charged, not the levers that compute it.
 *
 *   up to 2% below the current rate   auto        logged, EOD exception report
 *   more than 2% below                sibu        Sibu, or an owner
 *   below cost (R-16)                 owner       Yash or Manoj only
 *
 * `rate_variance.approve` is the grant Sibu holds for the middle tier — a
 * grant rather than a name check, same reasoning as R-11's own comment: a
 * rule naming a duty should be satisfiable by handing somebody that duty, but
 * the OWNER tier stays wildcard-only on purpose, same as R-11 and R-16 always
 * have been.
 */
const TIER_RANK = { auto: 0, sibu: 1, owner: 2 };

function tierFor(field, current, next, costPrice) {
  if (field !== 'base_price' || current === null || next === null || next >= current) {
    return { tier: 'owner', variance: null };
  }
  const variance = Number((((current - next) / current) * 100).toFixed(2));
  if (costPrice !== null && next < costPrice) return { tier: 'owner', variance };
  if (variance > 2) return { tier: 'sibu', variance };
  return { tier: 'auto', variance };
}

const approvesVariance = (user) => approvesRates(user) || userCan(user, 'rate_variance.approve');

/**
 * POST /api/items/import — upload a rate-card spreadsheet from the app.
 *
 * "I upload the excel, they fetch the data and add to the table, and always
 * I upload it they compare with the new one and those are missing they add,
 * rest of them ignore" — the owner's own description of the rule. So this is
 * deliberately NOT the CLI importer's default behaviour: an existing item is
 * never touched, only a genuinely new name is inserted. A rate that needs
 * correcting still goes through Gaurav and R-11, not a spreadsheet upload —
 * an upload that could silently reprice 8,900 items on a bad file is exactly
 * the mistake this mode is built to be safe against.
 *
 * The uploaded file must keep the same sheet name and column order as the
 * two originals — `KL_LAYOUT` / `LEMAC_LAYOUT` describe a fixed spreadsheet,
 * not an arbitrary one, and guessing a layout from an unfamiliar file is how
 * a rate lands in the wrong column silently.
 *
 * Gated on the same check R-11 approval uses: this can create up to 8,900
 * rows of pricing data in one request, which is a bigger blast radius than
 * `items.create` was ever meant to cover.
 */
router.post('/import', async (req, res, next) => {
  if (!approvesRates(req.user)) {
    return res.status(403).json({
      error: 'Importing the rate card is Yash or Manoj only.',
      code: 'IMPORT_DENIED',
    });
  }

  const { data, filename } = req.body || {};
  if (!data) return res.status(400).json({ error: 'No file received.' });

  let wb;
  try {
    wb = XLSX.read(Buffer.from(data, 'base64'), { type: 'buffer', cellDates: false });
  } catch {
    return res.status(400).json({ error: 'That file could not be read as a spreadsheet.' });
  }

  const layout = wb.SheetNames.includes(KL_LAYOUT.sheet) ? KL_LAYOUT
    : wb.SheetNames.includes(LEMAC_LAYOUT.sheet) ? LEMAC_LAYOUT
      : null;

  if (!layout) {
    return res.status(400).json({
      error: `No recognised sheet in this file — expected "${KL_LAYOUT.sheet}" or `
        + `"${LEMAC_LAYOUT.sheet}". Found: ${wb.SheetNames.join(', ')}.`,
      code: 'UNKNOWN_LAYOUT',
    });
  }

  const conn = await pool.getConnection();
  try {
    const warnings = [];
    const warn = (m) => { if (warnings.length < 40) warnings.push(m); };

    await conn.beginTransaction();
    const stats = await importFile(conn, wb, layout, { addOnly: true, warn });

    await conn.query(
      `INSERT INTO item_import_log
         (source_file, sheet_name, rows_read, rows_created, rows_updated, rows_skipped, note, imported_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [filename || 'uploaded.xlsx', layout.sheet, stats.read, stats.created, stats.updated,
        stats.skipped, `add-only import; ${stats.ignored} already on file, ${stats.unpriced} unpriced`,
        req.user.id]
    );
    await conn.commit();

    res.status(201).json({
      message: stats.created
        ? `${stats.created} new item(s) added. ${stats.ignored} already on file were left as they were.`
        : `Nothing new. All ${stats.ignored} matched an item already on file.`,
      created: stats.created,
      ignored: stats.ignored,
      skipped: stats.skipped,
      unpriced: stats.unpriced,
      created_names: stats.createdNames,
      warnings,
    });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

/**
 * Record a proposed rate change instead of making it.
 *
 * Returns the request, or an `{ error, status }` shape the caller turns into a
 * response. Any earlier pending request for the same field is superseded rather
 * than left to queue: two requests for one number would be approved in whatever
 * order somebody happened to tap, and the second would silently undo the first.
 */
async function proposeRateChange(itemId, fields, body, user) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[item]] = await conn.query(
      'SELECT * FROM items WHERE masterid = ? FOR UPDATE', [itemId]);
    if (!item) {
      await conn.rollback();
      return { error: 'Item not found', status: 404 };
    }

    const batch = `RC${Date.now().toString(36).toUpperCase()}`;
    const costPrice = item.cost_price === null || item.cost_price === undefined
      ? null : Number(item.cost_price);
    const changes = [];

    for (const field of fields) {
      const next = body[field] === null || body[field] === '' ? null : Number(body[field]);
      if (next !== null && !Number.isFinite(next)) {
        await conn.rollback();
        return { error: `${field} must be a number.`, status: 400, code: 'BAD_VALUE' };
      }
      const current = item[field] === null || item[field] === undefined
        ? null : Number(item[field]);

      // Nothing proposed is not a proposal. Skipping it keeps the approval
      // queue free of rows that would change nothing when approved.
      if (current === next) continue;

      const { tier, variance } = tierFor(field, current, next, costPrice);
      changes.push({ field, from: current, to: next, tier, variance });
    }

    if (!changes.length) {
      await conn.rollback();
      return { error: 'Those values are already set. Nothing to approve.', status: 400, code: 'NO_CHANGE' };
    }

    // A batch is only as lenient as its strictest row — one field needing an
    // owner escalates the whole submission, because approving "the batch"
    // half-tiered would apply some fields on a lower bar than the person
    // deciding realised they were signing off on.
    const batchTier = changes.reduce(
      (worst, c) => (TIER_RANK[c.tier] > TIER_RANK[worst] ? c.tier : worst), 'auto');
    const autoApply = batchTier === 'auto';

    for (const c of changes) {
      await conn.query(
        `UPDATE item_rate_changes SET status = 'superseded'
          WHERE item_id = ? AND field = ? AND status = 'pending'`,
        [itemId, c.field]);

      if (autoApply) {
        if (!RATE_WRITABLE.includes(c.field)) {
          await conn.rollback();
          return { error: `${c.field} is not a rate column.`, status: 400, code: 'BAD_FIELD' };
        }
        await conn.query(`UPDATE items SET ${c.field} = ? WHERE masterid = ?`, [c.to, itemId]);
      }

      await conn.query(
        `INSERT INTO item_rate_changes
           (item_id, item_name, field, tier, variance_percent, old_value, new_value,
            batch_ref, reason, requested_by, status, decided_by, decided_at,
            decision_note, applied_from)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [itemId, item.name, c.field, c.tier, c.variance, c.from, c.to, batch,
          body.reason || null, user.id,
          autoApply ? 'auto_approved' : 'pending',
          autoApply ? null : null,
          autoApply ? new Date() : null,
          autoApply ? `Auto-approved — ${c.variance}% below rate, within the 2% band.` : null,
          autoApply ? c.from : null]);
    }

    // Everyone who could act on this hears about it either way — an
    // auto-applied change is still "logged" per 3.2, and a pending one is
    // waiting on Sibu or an owner depending on batchTier.
    const recipients = batchTier === 'sibu'
      ? new Set([...await usersWhoCan(conn, 'all'), ...await usersWhoCan(conn, 'rate_variance.approve')])
      : new Set(await usersWhoCan(conn, 'all'));

    for (const recipient of recipients) {
      await notify(conn, {
        userId: recipient,
        tone: autoApply ? 'info' : 'warning',
        title: autoApply
          ? `Rate auto-adjusted — ${item.name}`
          : `Rate change proposed — ${item.name}`,
        body: changes.map((c) => `${c.field}: ${c.from} → ${c.to}`
          + (c.variance !== null ? ` (${c.variance}% below rate)` : '')).join('; ')
          + ` (${user.name})`,
        actor: user.id,
        refType: 'rate_change',
        refId: itemId,
      });
    }

    await conn.commit();
    return {
      batch_ref: batch, changes, item_id: Number(itemId), item_name: item.name,
      tier: batchTier, auto_applied: autoApply,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * GET /api/items/rate-changes — the approval queue (R-11).
 *
 * Readable by anyone who may see a rate, so Gaurav can see what he is waiting
 * on. Only an owner may decide.
 */
router.get('/rate-changes', requirePermission('items.rates'), async (req, res, next) => {
  try {
    const status = ['pending', 'approved', 'rejected', 'superseded']
      .includes(req.query.status) ? req.query.status : 'pending';

    const [rows] = await pool.query(
      `SELECT rc.*, r.name AS requested_by_name, d.name AS decided_by_name
         FROM item_rate_changes rc
         LEFT JOIN users r ON r.id = rc.requested_by
         LEFT JOIN users d ON d.id = rc.decided_by
        WHERE rc.status = ?
        ORDER BY rc.requested_at DESC, rc.id DESC
        LIMIT 300`, [status]);

    // Grouped by submission, because that is what gets approved. A batch's
    // own required tier is the strictest of its rows, same rule proposeRateChange
    // uses to decide whether it auto-applied.
    const batches = new Map();
    for (const r of rows) {
      const key = r.batch_ref || `single-${r.id}`;
      if (!batches.has(key)) {
        batches.set(key, {
          batch_ref: r.batch_ref,
          item_id: r.item_id,
          item_name: r.item_name,
          requested_by: r.requested_by_name,
          requested_at: r.requested_at,
          reason: r.reason,
          status: r.status,
          tier: 'auto',
          changes: [],
        });
      }
      const entry = batches.get(key);
      if (TIER_RANK[r.tier] > TIER_RANK[entry.tier]) entry.tier = r.tier;
      entry.changes.push({
        id: r.id, field: r.field, from: r.old_value, to: r.new_value,
        tier: r.tier, variance_percent: r.variance_percent,
      });
    }

    res.json({
      status,
      batches: [...batches.values()].map((b) => ({
        ...b,
        can_decide: b.tier === 'owner' ? approvesRates(req.user) : approvesVariance(req.user),
      })),
      can_approve: approvesRates(req.user),
      can_approve_variance: approvesVariance(req.user),
    });
  } catch (err) { next(err); }
});

/**
 * POST /api/items/rate-changes/:batch/decide — R-11.
 *
 * The value is applied from whatever the column holds NOW, and what that was is
 * recorded in `applied_from`. A request can sit for days; approving it against
 * the value the proposer saw would silently revert anything that moved in
 * between, and the difference is exactly what an audit would ask about.
 */
router.post('/rate-changes/:batch/decide', async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const approve = req.body?.approve === true || req.body?.approve === 'true';
    await conn.beginTransaction();

    const [rows] = await conn.query(
      "SELECT * FROM item_rate_changes WHERE batch_ref = ? AND status = 'pending' FOR UPDATE",
      [req.params.batch]);

    if (!rows.length) {
      await conn.rollback();
      return res.status(404).json({
        error: 'No pending rate change with that reference.', code: 'NOT_FOUND' });
    }

    // 3.2 — a batch needs the strictest tier any of its rows carries. Sibu
    // (via `rate_variance.approve`) may clear a 'sibu' batch; only Yash or
    // Manoj may clear an 'owner' one — unchanged from R-11/R-16.
    const batchTier = rows.reduce(
      (worst, r) => (TIER_RANK[r.tier] > TIER_RANK[worst] ? r.tier : worst), 'auto');
    const authorized = batchTier === 'owner' ? approvesRates(req.user) : approvesVariance(req.user);
    if (!authorized) {
      await conn.rollback();
      return res.status(403).json({
        error: batchTier === 'owner'
          ? 'A rate adjustment below cost is approved by Yash or Manoj only.'
          : 'This rate adjustment needs Sibu or an owner to approve it.',
        code: 'RATE_APPROVAL_DENIED',
      });
    }

    const applied = [];
    for (const change of rows) {
      if (approve) {
        // Whitelisted again here. The field came from RATE_WRITABLE when the
        // request was made, but this is the statement that interpolates it into
        // SQL, and a check at the far end of a queue is not a check.
        if (!RATE_WRITABLE.includes(change.field)) {
          await conn.rollback();
          return res.status(400).json({
            error: `${change.field} is not a rate column.`, code: 'BAD_FIELD' });
        }

        const [[current]] = await conn.query(
          `SELECT ${change.field} AS value FROM items WHERE masterid = ? FOR UPDATE`,
          [change.item_id]);

        await conn.query(
          `UPDATE items SET ${change.field} = ? WHERE masterid = ?`,
          [change.new_value, change.item_id]);

        await conn.query(
          `UPDATE item_rate_changes
              SET status = 'approved', decided_by = ?, decided_at = NOW(),
                  decision_note = ?, applied_from = ?
            WHERE id = ?`,
          [req.user.id, req.body?.note || null, current?.value ?? null, change.id]);

        applied.push({ field: change.field, from: current?.value ?? null, to: change.new_value });
      } else {
        await conn.query(
          `UPDATE item_rate_changes
              SET status = 'rejected', decided_by = ?, decided_at = NOW(), decision_note = ?
            WHERE id = ?`,
          [req.user.id, req.body?.note || null, change.id]);
      }
    }

    if (rows[0].requested_by) {
      await notify(conn, {
        userId: rows[0].requested_by,
        tone: approve ? 'success' : 'warning',
        title: approve ? 'Rate change approved' : 'Rate change declined',
        body: `${rows[0].item_name} — ${rows.length} field(s).`
          + (req.body?.note ? ` ${req.body.note}` : ''),
        actor: req.user.id,
        refType: 'rate_change',
        refId: rows[0].item_id,
      });
    }

    await conn.commit();
    res.json({
      message: approve ? 'Rate change approved and applied.' : 'Rate change declined.',
      applied,
    });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

// GET /api/items — List catalog items with search & filter
/**
 * R-07 — "Rate columns and values are completely hidden — not just greyed out —
 * on Sonu's account."
 *
 * Hidden means absent from the payload, not hidden by CSS. Sonu receives
 * goods; he is not to know what they cost or sell for, and a rate delivered to
 * the device and then not drawn is still a rate delivered to the device.
 *
 * `items.rates` is the grant that reveals them. It is separate from
 * `items.view` on purpose: Sonu needs the item list to receive against, and
 * removing his view grant would take the list away with the rates.
 */
const RATE_COLUMNS = [
  'rate', 'base_price', 'pricing_type', 'cost_price', 'discount',
  'disc_dealer', 'disc_builder_direct', 'disc_builder_comm',
  'disc_retail_direct', 'disc_retail_comm', 'disc_electrician',
  'ratio_builder_direct', 'ratio_builder_comm', 'ratio_retail_direct',
  'ratio_retail_comm', 'ratio_electrician',
  'comm_retail_agent', 'comm_builder_agent',
];

/**
 * Two different rules, and conflating them broke the order screen.
 *
 *   R-07  "Rate columns and values are completely hidden — not just greyed
 *          out — on Sonu's account."         → who may SEE a rate
 *   R-04  "Only Gaurav has the ability to edit item rates."
 *                                            → who may CHANGE one
 *
 * Seeing is the broad grant. Every salesman needs it — "Rate auto-populates
 * based on the selected customer type... The previous rate is displayed
 * alongside for reference" (4.1) — and so does anyone quoting or billing.
 * Sonu is the single exception the document names.
 *
 * Editing is the narrow one, and it is Gaurav alone. Gating both on one grant
 * left every salesman with an item list carrying no rates, which is an order
 * screen that cannot price an order.
 *
 * The edit grant is `items.pricing`, NOT `items.rates.edit`. A grant covers
 * everything beneath it, so `items.rates` — held by every salesman so they can
 * quote — would have satisfied `items.rates.edit` and handed the whole field
 * force the rate card. The two must be SIBLINGS under `items`, not parent and
 * child, and only the area grant implies both.
 */
const seesRates = (user) => userCan(user, 'items') || userCan(user, 'items.rates');
const editsRates = (user) => userCan(user, 'items') || userCan(user, 'items.pricing');

function stripRates(rows, user) {
  if (seesRates(user)) return rows;
  return rows.map((row) => {
    const out = { ...row };
    for (const c of RATE_COLUMNS) delete out[c];
    return out;
  });
}

router.get('/', requirePermission('items.view'), async (req, res, next) => {
  try {
    const { search, category, brand, activeOnly = 'true' } = req.query;
    let sql = 'SELECT * FROM items WHERE 1=1';
    const params = [];

    if (activeOnly === 'true') {
      sql += ' AND is_active = TRUE';
    }
    if (search) {
      sql += ' AND (name LIKE ? OR code LIKE ? OR hsn LIKE ? OR category LIKE ?)';
      const term = `%${search.trim()}%`;
      params.push(term, term, term, term);
    }
    if (category) {
      sql += ' AND category = ?';
      params.push(category);
    }
    if (brand) {
      sql += ' AND brand = ?';
      params.push(brand);
    }

    // Total against the same WHERE, before LIMIT/OFFSET are applied — the
    // catalog table needs to say "8,885 items" and page through them, which a
    // capped page of rows cannot answer on its own.
    const [[{ total }]] = await pool.query(
      sql.replace('SELECT *', 'SELECT COUNT(*) AS total'), params
    );

    // Bounded. The master holds 8,900 items and this used to return every one
    // of them on every keystroke of a live search — several megabytes to a
    // phone on a shop's wifi.
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    sql += ' ORDER BY name ASC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const [rows] = await pool.query(sql, params);
    res.json({ items: stripRates(rows, req.user), limit, offset, total });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/items/:id/rates — the six rates for one item.
 *
 * The order screen asks for this once a customer type is known. It returns all
 * six rather than the one, because the party card shows what the same goods
 * would cost the other types and that is what a salesman negotiates against.
 *
 * A type with no rate comes back as null rather than being left out: "we have
 * no builder rate for this" is information, and an absent key reads as zero.
 */
router.get('/:id/rates', requirePermission('items.rates'), async (req, res, next) => {
  try {
    const [[item]] = await pool.query('SELECT * FROM items WHERE masterid = ?', [req.params.id]);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    res.json({
      item_id: item.masterid,
      name: item.name,
      pricing_type: item.pricing_type,
      base_price: Number(item.base_price),
      rates: allRates(item),
      commission: {
        electrician: item.comm_retail_agent === null ? null : Number(item.comm_retail_agent),
        builder: item.comm_builder_agent === null ? null : Number(item.comm_builder_agent),
      },
      scheme_weightage: item.scheme_weightage === null ? null : Number(item.scheme_weightage),
      cost_price: item.cost_price === null ? null : Number(item.cost_price),
      // Named so the client can say WHY a type has no rate rather than showing
      // a blank cell.
      unpriced_reason: item.pricing_type ? null : 'This item has no rate card yet.',
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/items/:id — Single item details
router.get('/:id', requirePermission('items.view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT * FROM items WHERE masterid = ?', [req.params.id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }
    res.json({ item: stripRates(rows, req.user)[0] });
  } catch (err) {
    next(err);
  }
});

// POST /api/items — Create new item
router.post('/', requirePermission('items.create'), async (req, res, next) => {
  try {
    const { name, code, brand, category, hsn, gst_percent = 18, unit = 'PCS', rate = 0, discount = 0, initial_stock = 0 } = req.body;
    if (!name?.trim()) {
      return res.status(400).json({ error: 'Item name is required' });
    }
    if (Number(rate) < 0 || Number(gst_percent) < 0 || Number(initial_stock) < 0) {
      return res.status(400).json({ error: 'Rate, GST and opening stock cannot be negative' });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [result] = await conn.query(
        `INSERT INTO items (name, code, brand, category, hsn, gst_percent, unit, rate, discount, qty, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE)`,
        [name.trim(), code || null, brand || null, category || null, hsn || null, gst_percent, unit, rate, discount, initial_stock]
      );

      const itemId = result.insertId;

      if (Number(initial_stock) > 0) {
        await conn.query(
          `INSERT INTO stock_movements (item_id, change_qty, reason, note, created_by)
           VALUES (?, ?, 'opening', 'Initial opening stock', ?)`,
          [itemId, initial_stock, req.user.id]
        );
      }

      await conn.commit();
      res.status(201).json({ message: 'Item created successfully', masterid: itemId });
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  } catch (err) {
    next(err);
  }
});

// PUT /api/items/:id — Update item details
//
// A partial update. The previous version wrote every column from the body, so
// a request carrying only { name } blanked the code, brand, HSN, rate and GST,
// and set is_active to NULL — which is falsey, so the item then disappeared
// from the default listing.
/**
 * PUT /api/items/:id — two different permissions, one route.
 *
 * The route is NOT guarded as a whole, because two disjoint groups of people
 * may write to an item and neither is a subset of the other:
 *
 *   `items.edit`        the master — name, unit, HSN, godown, rack. Sonu's job:
 *                       he maintains what an item IS. R-07 keeps him off rates.
 *   `items.pricing`  the rate card. Gaurav's alone (R-04), and what he
 *                       submits is a request, not a change (R-11).
 *
 * Guarding the router on `items.edit` locked Gaurav out entirely — he holds no
 * master grant and does not need one — so he could not propose a rate at all,
 * and R-11 was unreachable rather than merely unimplemented.
 *
 * Each group of fields is therefore checked against its own grant below, and a
 * request touching neither is refused.
 */
router.put('/:id', async (req, res, next) => {
  try {
    const updates = [];
    const values = [];

    const masterEdits = WRITABLE.filter((c) => req.body[c] !== undefined);
    if (masterEdits.length && !(userCan(req.user, 'items') || userCan(req.user, 'items.edit'))) {
      return res.status(403).json({
        error: 'You cannot change an item\'s details.',
        code: 'ITEM_EDIT_DENIED',
        fields: masterEdits,
      });
    }

    for (const column of masterEdits) {
      updates.push(`${column} = ?`);
      values.push(req.body[column]);
    }

    // R-04 — the rate card is Gaurav's alone. Refused rather than silently
    // dropped: an operator who edits a discount and is told "saved" while
    // nothing moved will keep editing it.
    const rateEdits = RATE_WRITABLE.filter((c) => req.body[c] !== undefined);
    if (rateEdits.length) {
      if (!editsRates(req.user)) {
        return res.status(403).json({
          error: 'Only the rate keeper can change pricing. Ask Gaurav.',
          code: 'RATE_EDIT_DENIED',
          fields: rateEdits,
        });
      }

      // R-11 — "Gaurav can initiate a rate adjustment but cannot approve it.
      // Only Yash or Manoj can approve."
      //
      // So holding the rate-edit grant produces a REQUEST, not a change. An
      // owner is the approver, so their edit applies immediately — anything
      // else would mean Yash raising a request for himself to approve.
      if (!approvesRates(req.user)) {
        const pending = await proposeRateChange(req.params.id, rateEdits, req.body, req.user);
        if (pending.error) return res.status(pending.status).json(pending);

        // If the caller sent ONLY rate fields there is nothing left to save, so
        // the response is about the request rather than about the item.
        //
        // 3.2 — a within-2%-below decrease auto-applies (see tierFor above),
        // so this is sometimes reporting a change that already happened, not
        // one still waiting on somebody.
        if (!updates.length) {
          return res.status(pending.auto_applied ? 200 : 202).json({
            message: pending.auto_applied
              ? 'Rate adjusted — within 2% of the current rate, auto-approved and logged.'
              : `Rate change submitted for approval (${pending.tier === 'sibu' ? 'Sibu' : 'Yash or Manoj'}).`,
            code: pending.auto_applied ? 'RATE_CHANGE_APPLIED' : 'RATE_CHANGE_PENDING',
            ...pending,
          });
        }
        // Mixed submission: the non-rate fields save now, the rates wait.
        req._pendingRateChange = pending;
      } else {
        for (const column of rateEdits) {
          updates.push(`${column} = ?`);
          values.push(req.body[column]);
        }
      }
    }

    if (!updates.length) {
      return res.status(400).json({ error: 'Nothing to update' });
    }
    if (req.body.name !== undefined && !String(req.body.name).trim()) {
      return res.status(400).json({ error: 'Item name cannot be empty' });
    }

    values.push(req.params.id);
    const [result] = await pool.query(
      `UPDATE items SET ${updates.join(', ')} WHERE masterid = ?`,
      values
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }

    const [[item]] = await pool.query('SELECT * FROM items WHERE masterid = ?', [req.params.id]);
    res.json({
      message: req._pendingRateChange
        ? 'Item updated. The rate change is waiting on approval.'
        : 'Item updated successfully',
      item: stripRates([item], req.user)[0],
      pending_rate_change: req._pendingRateChange || null,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/items/:id/stock — Stock adjustment
router.post('/:id/stock', requirePermission('items.edit'), async (req, res, next) => {
  try {
    const { change_qty, reason = 'adjustment', note = '' } = req.body;
    const delta = Number(change_qty);
    if (!Number.isFinite(delta) || delta === 0) {
      return res.status(400).json({ error: 'Valid change_qty is required' });
    }
    if (!['receipt', 'adjustment', 'return', 'opening'].includes(reason)) {
      // 'order' is written by the orders route alone, so a movement can never
      // claim to belong to an order that does not exist.
      return res.status(400).json({ error: 'Invalid stock movement reason' });
    }

    const itemId = req.params.id;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [[item]] = await conn.query('SELECT masterid FROM items WHERE masterid = ? FOR UPDATE', [itemId]);
      if (!item) {
        await conn.rollback();
        return res.status(404).json({ error: 'Item not found' });
      }

      await conn.query(
        `INSERT INTO stock_movements (item_id, change_qty, reason, note, created_by)
         VALUES (?, ?, ?, ?, ?)`,
        [itemId, delta, reason, note, req.user.id]
      );

      await conn.query(
        `UPDATE items SET qty = (SELECT COALESCE(SUM(change_qty), 0) FROM stock_movements WHERE item_id = ?)
         WHERE masterid = ?`,
        [itemId, itemId]
      );

      await conn.commit();
      const [[updated]] = await pool.query('SELECT masterid, qty FROM items WHERE masterid = ?', [itemId]);
      res.json({ message: 'Stock updated successfully', item: updated });
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  } catch (err) {
    next(err);
  }
});

module.exports = router;
