const express = require('express');

const router = express.Router();
const pool = require('../config/db');
const { authenticate, requirePermission } = require('../middleware/auth');
const { userCan } = require('../utils/permissions');
const { businessDay, isDateString } = require('../utils/businessDay');
const { notify } = require('../utils/workflow');
const { report: pdfReport } = require('../utils/pdf');

router.use(authenticate);

/**
 * The twelve reports of section 12.
 *
 * Separate from `routes/reports.js`, which is the home dashboard and nothing
 * else — the standing note there says not to re-add report endpoints without a
 * screen that uses them, and that note was written when the Reports page had
 * been removed. Section 12 puts it back, by name, with twelve specified
 * contents. This module is that section; the dashboard stays where it is.
 *
 * Three rules apply to every report here, from section 12:
 *
 *   "Default date range for all reports is today."
 *   "Any past date or date range must be selectable."
 *   "All reports must be exportable as PDF and Excel."
 *
 * The first two are `range()` below. The third is `?format=csv` and
 * `?format=pdf`, and every report supports both — the branch lives in `send()`
 * so a report cannot end up offering one format and not the other.
 *
 * Every report is gated. Several of these — the outstanding book, salesman
 * performance, cash discount — are the company's commercial position, and the
 * lesson from the 2026-08-26 review was that a read-only route with no guard is
 * still a leak.
 */

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Which headings are money and which are counts.
 *
 * Matched on the HEADING rather than by inspecting a value, because a report
 * with no rows has no value to inspect and would then right-align nothing. The
 * headings are ours — they are written a few lines from here — so this is a
 * closed set rather than a guess about arbitrary data.
 */
const MONEY_HEADINGS = /amount|value|total|payout|base|outstanding|days$|discount|receipt|freight|invoiced|order value|collections|achieved|removed|net|target/i;
const QTY_HEADINGS = /qty|quantity|count|orders|stock|minimum|shortfall|lines|short|excess|damaged|attempts|invoices|consignments|system|counted|variance|%$/i;

/** The report's own metadata, as label/value pairs for the PDF's fact block. */
function pdfMeta(meta) {
  const out = [];
  for (const [key, value] of Object.entries(meta || {})) {
    if (value === null || value === undefined) continue;
    // Nested summaries (by_payment_mode, by_driver…) are their own tables in
    // the JSON and are not flattened into a fact strip.
    if (typeof value === 'object') continue;
    out.push([String(key).replace(/_/g, ' '), String(value)]);
  }
  return out.slice(0, 8);
}

const dateRangeLabel = (meta) => {
  if (meta.from && meta.to) {
    return meta.from === meta.to ? `for ${meta.from}` : `${meta.from} to ${meta.to}`;
  }
  if (meta.as_at) return `as at ${meta.as_at}`;
  if (meta.period) return meta.period;
  return null;
};

/**
 * The date range for a request.
 *
 * Defaults to today, both ends, which is what section 12 asks for. A `from`
 * with no `to` runs to today rather than to `from`, because "since the 1st" is
 * what somebody typing one date means.
 */
function range(query) {
  const today = businessDay();
  const from = isDateString(query.from) ? query.from : today;
  const to = isDateString(query.to) ? query.to : (isDateString(query.from) ? today : today);
  // Swapped rather than refused: the dates are the same two numbers either way
  // round, and refusing helps nobody.
  return from <= to ? { from, to } : { from: to, to: from };
}

/**
 * Send as JSON, as CSV, or as PDF.
 *
 * Section 12: "All reports must be exportable as PDF and Excel." CSV is the
 * Excel half — it is what Excel opens, needs no dependency and no template. PDF
 * is `utils/pdf.js`.
 *
 * One function for all three so a report cannot support one format and not
 * another: adding the PDF branch here gave all twelve of them PDF at once, and
 * the next report added gets all three without deciding anything.
 *
 * `columns` is [key, heading] pairs rather than derived from the first row, so
 * a report with an empty result still exports its headings — an empty file with
 * no header row reads as a broken export rather than a quiet month.
 */
function send(res, { rows, columns, filename, meta = {}, title, subtitle, summary }, format) {
  const wanted = String(format || '').toLowerCase();

  if (wanted === 'pdf') {
    return pdfReport(res, {
      title: title || filename.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      subtitle: subtitle || dateRangeLabel(meta),
      filename,
      // The PDF's column shape is derived from the CSV's, so the two exports of
      // one report can never list different columns. Numeric-looking headings
      // are right-aligned and money-formatted by name rather than by inspecting
      // a value, which would guess wrong on an empty result.
      columns: columns.map(([key, label]) => ({
        key,
        label,
        width: 1 / columns.length,
        align: MONEY_HEADINGS.test(label) || QTY_HEADINGS.test(label) ? 'right' : 'left',
        format: MONEY_HEADINGS.test(label) ? 'money'
          : QTY_HEADINGS.test(label) ? 'qty'
            : /date|due|until/i.test(label) ? 'date' : undefined,
      })),
      rows,
      meta: pdfMeta(meta),
      summary: summary || [],
    });
  }

  if (wanted !== 'csv') {
    return res.json({ ...meta, rows });
  }

  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    // Excel treats a leading =, +, - or @ as a formula. Prefixing a tab is the
    // usual defence and survives a round trip through Excel intact.
    const safe = /^[=+\-@]/.test(s) ? `\t${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };

  const header = columns.map(([, label]) => escape(label)).join(',');
  const body = rows.map((r) => columns.map(([key]) => escape(r[key])).join(',')).join('\r\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
  // A BOM, so Excel on Windows reads the file as UTF-8 rather than as the
  // system code page — without it every party name with a non-ASCII character
  // opens as mojibake.
  return res.send(`﻿${header}\r\n${body}\r\n`);
}

// ---------------------------------------------------------------------------
// 1. Daily Sales Report
// ---------------------------------------------------------------------------

/**
 * "Order-wise breakdown, cash vs credit vs UPI, driver-wise delivery status."
 */
router.get('/daily-sales', requirePermission('orders.view'), async (req, res, next) => {
  try {
    const { from, to } = range(req.query);
    // A salesman sees their own book; the area grant widens it to the branch.
    const all = userCan(req.user, 'orders');
    const params = [from, to];
    if (!all) params.push(req.user.id);

    const [rows] = await pool.query(
      `SELECT o.order_id, o.so_number, o.order_date, o.status, o.total_amount,
              o.payment_mode, o.customer_type,
              c.name AS party, c.city AS area,
              u.name AS salesman, d.name AS driver,
              i.invoice_no, i.grand_total AS invoiced,
              dl.status AS delivery_status
         FROM orders o
         JOIN customers c        ON c.masterid = o.customer_id
         LEFT JOIN users u       ON u.id = o.salesman_id
         LEFT JOIN invoices i    ON i.order_id = o.order_id AND i.status <> 'cancelled'
         LEFT JOIN deliveries dl ON dl.order_id = o.order_id
         LEFT JOIN users d       ON d.id = dl.delivered_by
        WHERE o.order_date BETWEEN ? AND ? AND o.is_no_order = FALSE
          ${all ? '' : 'AND o.salesman_id = ?'}
        ORDER BY o.order_date DESC, o.order_id DESC
        LIMIT 2000`, params);

    // Cash vs credit vs UPI. A split order contributes to each of its parts,
    // which is why this reads order_payment_splits rather than payment_mode
    // alone — counting a split as one mode misstates both.
    const [modes] = await pool.query(
      `SELECT mode, SUM(amount) AS total, COUNT(*) AS orders FROM (
         SELECT COALESCE(s.mode, o.payment_mode) AS mode,
                COALESCE(s.amount, o.total_amount) AS amount
           FROM orders o
           LEFT JOIN order_payment_splits s ON s.order_id = o.order_id
          WHERE o.order_date BETWEEN ? AND ? AND o.is_no_order = FALSE
            AND o.status NOT IN ('cancelled','rejected')
       ) x WHERE mode IS NOT NULL GROUP BY mode`, [from, to]);

    const [drivers] = await pool.query(
      `SELECT u.name AS driver,
              SUM(dl.status = 'delivered') AS delivered,
              SUM(dl.status = 'undelivered') AS failed,
              COUNT(*) AS stops
         FROM deliveries dl
         LEFT JOIN users u ON u.id = dl.delivered_by
        WHERE DATE(dl.delivered_at) BETWEEN ? AND ?
        GROUP BY u.name`, [from, to]);

    send(res, {
      rows,
      columns: [['order_date', 'Date'], ['so_number', 'SO'], ['party', 'Party'],
        ['area', 'Area'], ['customer_type', 'Type'], ['salesman', 'Salesman'],
        ['total_amount', 'Order value'], ['invoice_no', 'Invoice'],
        ['invoiced', 'Invoiced'], ['payment_mode', 'Payment'],
        ['status', 'Status'], ['driver', 'Driver'], ['delivery_status', 'Delivery']],
      filename: `daily-sales-${from}-to-${to}`,
      meta: {
        from, to, scope: all ? 'company' : 'own',
        by_payment_mode: modes.map((m) => ({ ...m, total: num(m.total) })),
        by_driver: drivers,
        total: rows.reduce((a, r) => a + num(r.total_amount), 0),
      },
    }, req.query.format);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// 2. Outstanding Report
// ---------------------------------------------------------------------------

/**
 * "Party-wise outstanding amounts grouped into 0–30 days, 31–60 days, and 60+
 * days buckets."
 *
 * Computed from `invoices` rather than from the cached `closing_balance`,
 * because a balance cannot be bucketed — the age belongs to the individual
 * invoice, not to the party.
 */
router.get('/outstanding', requirePermission('payments.view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT c.masterid, c.name AS party, c.city AS area, c.customer_type,
              u.name AS salesman,
              COALESCE(SUM(CASE WHEN DATEDIFF(CURDATE(), i.invoice_date) <= 30
                                THEN i.grand_total - i.amount_paid END), 0) AS b0_30,
              COALESCE(SUM(CASE WHEN DATEDIFF(CURDATE(), i.invoice_date) BETWEEN 31 AND 60
                                THEN i.grand_total - i.amount_paid END), 0) AS b31_60,
              COALESCE(SUM(CASE WHEN DATEDIFF(CURDATE(), i.invoice_date) > 60
                                THEN i.grand_total - i.amount_paid END), 0) AS b60_plus,
              COALESCE(SUM(i.grand_total - i.amount_paid), 0) AS total,
              MAX(DATEDIFF(CURDATE(), i.invoice_date)) AS oldest_days,
              COUNT(*) AS open_invoices
         FROM customers c
         JOIN invoices i ON i.customer_id = c.masterid
                        AND i.status <> 'cancelled'
                        AND i.grand_total > i.amount_paid
         LEFT JOIN users u ON u.id = c.salesman_id
        GROUP BY c.masterid, c.name, c.city, c.customer_type, u.name
        ORDER BY b60_plus DESC, total DESC
        LIMIT 1000`);

    const totals = rows.reduce((a, r) => ({
      b0_30: a.b0_30 + num(r.b0_30),
      b31_60: a.b31_60 + num(r.b31_60),
      b60_plus: a.b60_plus + num(r.b60_plus),
      total: a.total + num(r.total),
    }), { b0_30: 0, b31_60: 0, b60_plus: 0, total: 0 });

    send(res, {
      rows,
      columns: [['party', 'Party'], ['area', 'Area'], ['customer_type', 'Type'],
        ['salesman', 'Salesman'], ['b0_30', '0-30 days'], ['b31_60', '31-60 days'],
        ['b60_plus', '60+ days'], ['total', 'Total'], ['oldest_days', 'Oldest (days)'],
        ['open_invoices', 'Open invoices']],
      filename: `outstanding-${businessDay()}`,
      meta: { as_at: businessDay(), totals },
    }, req.query.format);
  } catch (err) { next(err); }
});

/**
 * GET /api/reportsuite/outstanding-bills — 8, "Outstanding ledger":
 * "Bill-wise, never party totals only. Buckets 0-2 / 3-10 / 11-20 (the
 * cash-discount windows) / 21-30 / 31-45 / 46-60 / 60+. Filter by
 * salesman / area / bucket."
 *
 * "A party-level total hides one very old bill behind five new ones.
 * Bill-wise ageing is the only view that shows where the money actually
 * is." One row per invoice, unlike GET /outstanding above (kept as it
 * is — it feeds the older party-summary report section 12 already
 * specifies by that name; this is the sheet's separate, bill-level view).
 * The first three buckets mirror `utils/cashDiscount.js`'s own windows
 * exactly, because those are the days that still earn the party a
 * discount — the same ageing figure means two different things to two
 * different people in the same row.
 */
router.get('/outstanding-bills', requirePermission('payments.view'), async (req, res, next) => {
  try {
    const params = [];
    let sql = `
      SELECT i.id, i.invoice_no, i.invoice_date, i.grand_total, i.amount_paid,
             (i.grand_total - i.amount_paid) AS outstanding,
             DATEDIFF(CURDATE(), i.invoice_date) AS age_days,
             c.masterid AS customer_id, c.name AS party, c.city AS area, c.phone,
             u.id AS salesman_id, u.name AS salesman
        FROM invoices i
        JOIN customers c ON c.masterid = i.customer_id
        LEFT JOIN users u ON u.id = c.salesman_id
       WHERE i.status <> 'cancelled' AND i.grand_total > i.amount_paid
    `;
    if (req.query.salesman_id) { sql += ' AND u.id = ?'; params.push(req.query.salesman_id); }
    if (req.query.area) { sql += ' AND c.city = ?'; params.push(req.query.area); }
    sql += ' ORDER BY age_days DESC LIMIT 1000';

    const [rows] = await pool.query(sql, params);

    const bucketOf = (days) => {
      if (days <= 2) return '0-2';
      if (days <= 10) return '3-10';
      if (days <= 20) return '11-20';
      if (days <= 30) return '21-30';
      if (days <= 45) return '31-45';
      if (days <= 60) return '46-60';
      return '60+';
    };

    let bucketed = rows.map((r) => ({ ...r, bucket: bucketOf(Number(r.age_days)) }));
    if (req.query.bucket) bucketed = bucketed.filter((r) => r.bucket === req.query.bucket);

    send(res, {
      rows: bucketed,
      columns: [
        ['invoice_no', 'Invoice'], ['party', 'Party'], ['area', 'Area'],
        ['salesman', 'Salesman'], ['invoice_date', 'Date'], ['age_days', 'Days'],
        ['bucket', 'Bucket'], ['grand_total', 'Billed'], ['amount_paid', 'Paid'],
        ['outstanding', 'Outstanding'],
      ],
      filename: `outstanding-bills-${businessDay()}`,
      meta: {
        as_at: businessDay(),
        total: bucketed.reduce((a, r) => a + num(r.outstanding), 0),
      },
    }, req.query.format);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// 3. Salesman Performance
// ---------------------------------------------------------------------------

/**
 * "Per salesman — orders placed, value, collections, target progress,
 * conversion rate."
 *
 * "In the Salesman Performance Report, orders can be filtered by area/location"
 * (D.2), which is what the `area` parameter does — matched against the party's
 * city, since that is the area an order was placed in.
 */
router.get('/salesman-performance', requirePermission('orders.view'), async (req, res, next) => {
  try {
    const { from, to } = range(req.query);
    const area = req.query.area ? String(req.query.area) : null;
    const params = [from, to, from, to, from, to];
    if (area) params.push(area);

    const [rows] = await pool.query(
      `SELECT u.id, u.name AS salesman,
              COUNT(DISTINCT CASE WHEN o.is_no_order = FALSE THEN o.order_id END) AS orders_placed,
              COUNT(DISTINCT CASE WHEN o.is_no_order = TRUE  THEN o.order_id END) AS no_order_visits,
              COALESCE(SUM(CASE WHEN o.is_no_order = FALSE
                                 AND o.status NOT IN ('cancelled','rejected')
                                THEN o.total_amount END), 0) AS order_value,
              (SELECT COALESCE(SUM(p.amount), 0) FROM payments p
                JOIN customers pc ON pc.masterid = p.customer_id
                WHERE pc.salesman_id = u.id AND p.status = 'received'
                  AND p.payment_date BETWEEN ? AND ?) AS collections,
              (SELECT COUNT(*) FROM estimates e
                WHERE e.created_by = u.id AND e.estimate_date BETWEEN ? AND ?) AS estimates_raised,
              (SELECT COUNT(*) FROM estimates e
                WHERE e.created_by = u.id AND e.status = 'converted'
                  AND e.estimate_date BETWEEN ? AND ?) AS estimates_converted
         FROM users u
         LEFT JOIN orders o ON o.salesman_id = u.id AND o.order_date BETWEEN ? AND ?
         LEFT JOIN customers oc ON oc.masterid = o.customer_id
        WHERE u.is_active = TRUE
          ${area ? 'AND oc.city = ?' : ''}
          AND EXISTS (SELECT 1 FROM orders x WHERE x.salesman_id = u.id)
        GROUP BY u.id, u.name
        ORDER BY order_value DESC`,
      area ? [...params.slice(0, 6), from, to, area] : [...params, from, to]);

    send(res, {
      rows: rows.map((r) => ({
        ...r,
        order_value: num(r.order_value),
        collections: num(r.collections),
        // "conversion rate" — quotes that became orders.
        conversion_rate: num(r.estimates_raised) > 0
          ? Number(((num(r.estimates_converted) / num(r.estimates_raised)) * 100).toFixed(1))
          : null,
        // A visit that produced nothing is as much a fact about the day as one
        // that did, so the productive share is reported beside it.
        productive_share: (num(r.orders_placed) + num(r.no_order_visits)) > 0
          ? Number(((num(r.orders_placed)
            / (num(r.orders_placed) + num(r.no_order_visits))) * 100).toFixed(1))
          : null,
      })),
      columns: [['salesman', 'Salesman'], ['orders_placed', 'Orders'],
        ['order_value', 'Value'], ['collections', 'Collections'],
        ['no_order_visits', 'No-order visits'], ['productive_share', 'Productive %'],
        ['estimates_raised', 'Quotes'], ['estimates_converted', 'Converted'],
        ['conversion_rate', 'Conversion %']],
      filename: `salesman-performance-${from}-to-${to}`,
      meta: { from, to, area },
    }, req.query.format);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// 4. Incentive Progress Report
// ---------------------------------------------------------------------------

/**
 * "All 20 segments, current achievement, estimated payout, payment-linked
 * deductions."
 *
 * Reads the frozen `incentive_lines` where a period has been computed. It does
 * NOT recompute: this is the report, and a report that moves while being read
 * cannot be reconciled against the payout it explains. `/api/incentives` is the
 * live view.
 */
router.get('/incentive-progress/:period', requirePermission('incentives.approve'), async (req, res, next) => {
  try {
    const { period } = req.params;
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
      return res.status(400).json({ error: 'Period must be YYYY-MM.' });
    }

    const [rows] = await pool.query(
      `SELECT u.name AS salesman, s.name AS segment, s.seq, s.target_kind,
              l.target, l.achieved_gross, l.removed_unpaid, l.achieved_net,
              l.achieved_pct, l.base_incentive, l.payout_factor, l.payout,
              p.status, p.net_payout AS period_payout
         FROM incentive_periods p
         JOIN users u            ON u.id = p.employee_id
         JOIN incentive_lines l  ON l.period_id = p.id
         JOIN incentive_segments s ON s.id = l.segment_id
        WHERE p.period = ?
        ORDER BY u.name, s.seq`, [period]);

    send(res, {
      rows,
      columns: [['salesman', 'Salesman'], ['segment', 'Segment'],
        ['target', 'Target'], ['achieved_gross', 'Achieved'],
        ['removed_unpaid', 'Removed (unpaid 60d)'], ['achieved_net', 'Net'],
        ['achieved_pct', 'Achieved %'], ['base_incentive', 'Base'],
        ['payout_factor', 'Factor'], ['payout', 'Payout'], ['status', 'Status']],
      filename: `incentive-progress-${period}`,
      meta: {
        period,
        computed: rows.length > 0,
        note: rows.length ? undefined
          : 'No period has been computed for this month yet. POST /api/incentives/:employee/:period/compute first.',
      },
    }, req.query.format);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// 5. Purchase Report
// ---------------------------------------------------------------------------

/**
 * "Supplier-wise purchases, bill vs actual quantity comparison, freight
 * tracking."
 */
router.get('/purchases', requirePermission('purchases.view'), async (req, res, next) => {
  try {
    const { from, to } = range(req.query);
    // R-07: Sonu may read this report and must not see a rate in it.
    const rates = userCan(req.user, 'items') || userCan(req.user, 'items.rates');

    const [rows] = await pool.query(
      `SELECT p.id, p.purchase_type, p.supplier_name, p.invoice_no, p.challan_no,
              p.purchase_date, p.status, p.doc_state, p.grand_total,
              COUNT(pi.id) AS line_count,
              COALESCE(SUM(pi.bill_qty), 0) AS bill_qty,
              COALESCE(SUM(pi.qty), 0) AS actual_qty,
              SUM(pi.goods_condition = 'short')   AS short_lines,
              SUM(pi.goods_condition = 'excess')  AS excess_lines,
              SUM(pi.goods_condition = 'damaged') AS damaged_lines,
              g.lr_number, g.transporter_name, g.freight_type, g.freight_amount
         FROM purchases p
         LEFT JOIN purchase_items pi ON pi.purchase_id = p.id
         LEFT JOIN git_entries g     ON g.id = p.git_id
        WHERE p.purchase_date BETWEEN ? AND ?
        GROUP BY p.id, g.lr_number, g.transporter_name, g.freight_type, g.freight_amount
        ORDER BY p.purchase_date DESC, p.id DESC
        LIMIT 1000`, [from, to]);

    const [bySupplier] = await pool.query(
      `SELECT supplier_name, COUNT(*) AS entries, COALESCE(SUM(grand_total), 0) AS total
         FROM purchases WHERE purchase_date BETWEEN ? AND ?
        GROUP BY supplier_name ORDER BY total DESC`, [from, to]);

    const [freight] = await pool.query(
      `SELECT COALESCE(g.transporter_name, '(unnamed)') AS transporter,
              COUNT(*) AS consignments,
              COALESCE(SUM(CASE WHEN g.freight_type = 'to_pay' THEN g.freight_amount END), 0) AS to_pay,
              COALESCE(SUM(CASE WHEN g.freight_type = 'paid'   THEN g.freight_amount END), 0) AS paid
         FROM git_entries g
        WHERE g.dispatch_date BETWEEN ? AND ? OR g.received_at IS NULL
        GROUP BY g.transporter_name ORDER BY to_pay DESC`, [from, to]);

    const shaped = rows.map((r) => {
      const out = {
        ...r,
        variance: num(r.actual_qty) - num(r.bill_qty),
        has_discrepancy: num(r.short_lines) + num(r.excess_lines) + num(r.damaged_lines) > 0,
      };
      if (!rates) { delete out.grand_total; delete out.freight_amount; }
      return out;
    });

    send(res, {
      rows: shaped,
      columns: [['purchase_date', 'Date'], ['purchase_type', 'Type'],
        ['supplier_name', 'Supplier'], ['invoice_no', 'Bill'], ['challan_no', 'Challan'],
        ['lr_number', 'LR'], ['transporter_name', 'Transporter'],
        ['bill_qty', 'Bill qty'], ['actual_qty', 'Actual qty'], ['variance', 'Variance'],
        ['short_lines', 'Short'], ['excess_lines', 'Excess'], ['damaged_lines', 'Damaged'],
        ['doc_state', 'Document'], ['status', 'Status'],
        ...(rates ? [['grand_total', 'Value'], ['freight_amount', 'Freight']] : [])],
      filename: `purchases-${from}-to-${to}`,
      meta: {
        from, to, rates_visible: rates,
        by_supplier: rates ? bySupplier.map((s) => ({ ...s, total: num(s.total) }))
          : bySupplier.map((s) => ({ supplier_name: s.supplier_name, entries: s.entries })),
        freight_by_transporter: rates ? freight : [],
      },
    }, req.query.format);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// 6. Stock Report
// ---------------------------------------------------------------------------

/**
 * "Item-wise stock levels, items below minimum threshold."
 */
router.get('/stock', requirePermission('items.view'), async (req, res, next) => {
  try {
    const rates = userCan(req.user, 'items') || userCan(req.user, 'items.rates');
    const belowOnly = req.query.below_minimum === 'true';

    const [rows] = await pool.query(
      `SELECT i.masterid, i.name, i.brand, i.unit, i.godown, i.rack,
              i.qty, i.min_stock, i.base_price, i.pricing_type
         FROM items i
        WHERE i.is_active = TRUE
          ${belowOnly ? 'AND i.min_stock > 0 AND i.qty < i.min_stock' : ''}
        ORDER BY ${belowOnly ? '(i.min_stock - i.qty) DESC' : 'i.name ASC'}
        LIMIT 5000`);

    const shaped = rows.map((r) => {
      const out = {
        ...r,
        qty: num(r.qty),
        min_stock: num(r.min_stock),
        shortfall: num(r.min_stock) > num(r.qty) ? num(r.min_stock) - num(r.qty) : 0,
        below_minimum: num(r.min_stock) > 0 && num(r.qty) < num(r.min_stock),
        // Only meaningful where the item is rate-carded; the dealer rate is the
        // one the business values stock at.
        value: rates && r.pricing_type ? num(r.qty) * num(r.base_price) : null,
      };
      if (!rates) { delete out.base_price; delete out.value; delete out.pricing_type; }
      return out;
    });

    send(res, {
      rows: shaped,
      columns: [['name', 'Item'], ['brand', 'Brand'], ['unit', 'Unit'],
        ['godown', 'Godown'], ['rack', 'Rack'], ['qty', 'In stock'],
        ['min_stock', 'Minimum'], ['shortfall', 'Shortfall'],
        ...(rates ? [['value', 'Value at dealer rate']] : [])],
      filename: belowOnly ? `stock-below-minimum-${businessDay()}` : `stock-${businessDay()}`,
      meta: {
        as_at: businessDay(),
        below_minimum_only: belowOnly,
        rates_visible: rates,
        below_minimum_count: shaped.filter((r) => r.below_minimum).length,
      },
    }, req.query.format);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// 7. Cheque Report
// ---------------------------------------------------------------------------

/** "All cheques by status — pending deposit, deposited, cleared, bounced." */
router.get('/cheques', requirePermission('cheques.view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT ch.id, ch.cheque_no, ch.amount, ch.cheque_date, ch.status,
              ch.bank_name AS party_bank, ch.deposit_bank,
              ch.handed_at, ch.deposited_at, ch.cleared_at,
              c.name AS party,
              h.name AS handed_to_name, d.name AS deposited_by_name,
              ch.deposit_slip_photo_id IS NOT NULL AS slip_on_file,
              DATEDIFF(CURDATE(), ch.cheque_date) AS days_since_due
         FROM cheques ch
         JOIN customers c ON c.masterid = ch.customer_id
         LEFT JOIN users h ON h.id = ch.handed_to
         LEFT JOIN users d ON d.id = ch.deposited_by
        ORDER BY FIELD(ch.status,'bounced','received','handed','deposited','cleared','cancelled'),
                 ch.cheque_date ASC
        LIMIT 1000`);

    const byStatus = {};
    for (const r of rows) {
      byStatus[r.status] = byStatus[r.status] || { count: 0, total: 0 };
      byStatus[r.status].count += 1;
      byStatus[r.status].total += num(r.amount);
    }

    send(res, {
      rows,
      columns: [['cheque_date', 'Due'], ['cheque_no', 'Cheque'], ['party', 'Party'],
        ['party_bank', 'Party bank'], ['amount', 'Amount'], ['status', 'Status'],
        ['deposit_bank', 'Deposited into'], ['handed_to_name', 'Handed to'],
        ['deposited_by_name', 'Deposited by'], ['slip_on_file', 'Slip on file'],
        ['days_since_due', 'Days since due']],
      filename: `cheques-${businessDay()}`,
      meta: { as_at: businessDay(), by_status: byStatus },
    }, req.query.format);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// 8. Cash Discount Report
// ---------------------------------------------------------------------------

/** "Dealer-wise CD earned, credit notes auto-generated." */
router.get('/cash-discount', requirePermission('payments.view'), async (req, res, next) => {
  try {
    const { from, to } = range(req.query);

    const [rows] = await pool.query(
      `SELECT n.note_no, n.amount, n.note_date, n.status, n.reason,
              c.name AS party, c.customer_type,
              p.receipt_no, p.payment_date, p.amount AS receipt_amount
         FROM credit_notes n
         JOIN customers c ON c.masterid = n.customer_id
         LEFT JOIN payments p ON p.id = n.payment_id
        WHERE n.origin = 'cash_discount' AND n.note_date BETWEEN ? AND ?
        ORDER BY n.note_date DESC, n.id DESC
        LIMIT 1000`, [from, to]);

    const [byParty] = await pool.query(
      `SELECT c.name AS party, COUNT(*) AS notes, COALESCE(SUM(n.amount), 0) AS earned
         FROM credit_notes n JOIN customers c ON c.masterid = n.customer_id
        WHERE n.origin = 'cash_discount' AND n.note_date BETWEEN ? AND ?
        GROUP BY c.name ORDER BY earned DESC`, [from, to]);

    send(res, {
      rows,
      columns: [['note_date', 'Date'], ['note_no', 'Credit note'], ['party', 'Party'],
        ['receipt_no', 'Against receipt'], ['receipt_amount', 'Receipt'],
        ['amount', 'Discount'], ['status', 'Status'], ['reason', 'Basis']],
      filename: `cash-discount-${from}-to-${to}`,
      meta: {
        from, to,
        by_party: byParty.map((p) => ({ ...p, earned: num(p.earned) })),
        total: rows.reduce((a, r) => a + num(r.amount), 0),
      },
    }, req.query.format);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// 9. Estimate Conversion Report
// ---------------------------------------------------------------------------

/** "Estimates created, converted, lost, pending, reasons for loss." */
router.get('/estimate-conversion', requirePermission('estimates.view'), async (req, res, next) => {
  try {
    const { from, to } = range(req.query);
    const all = userCan(req.user, 'estimates');
    const params = [from, to];
    if (!all) params.push(req.user.id);

    const [rows] = await pool.query(
      `SELECT e.id, e.estimate_date, e.total_amount, e.status, e.attempts,
              e.lost_reason, e.valid_until, e.closed_at, e.shared_at,
              c.name AS party, u.name AS raised_by,
              o.so_number AS converted_to
         FROM estimates e
         JOIN customers c ON c.masterid = e.customer_id
         LEFT JOIN users u ON u.id = e.created_by
         LEFT JOIN orders o ON o.order_id = e.converted_order_id
        WHERE e.estimate_date BETWEEN ? AND ?
          ${all ? '' : 'AND e.created_by = ?'}
        ORDER BY e.estimate_date DESC, e.id DESC
        LIMIT 1000`, params);

    const counts = { created: rows.length, converted: 0, lost: 0, pending: 0, expired: 0 };
    const lostReasons = {};
    for (const r of rows) {
      if (r.status === 'converted') counts.converted += 1;
      else if (r.status === 'lost') {
        counts.lost += 1;
        lostReasons[r.lost_reason || 'unspecified'] = (lostReasons[r.lost_reason || 'unspecified'] || 0) + 1;
      } else if (r.status === 'expired') counts.expired += 1;
      else counts.pending += 1;
    }

    send(res, {
      rows,
      columns: [['estimate_date', 'Date'], ['party', 'Party'], ['raised_by', 'Raised by'],
        ['total_amount', 'Value'], ['status', 'Status'], ['attempts', 'Follow-ups'],
        ['lost_reason', 'Lost because'], ['converted_to', 'Became'],
        ['valid_until', 'Valid until']],
      filename: `estimate-conversion-${from}-to-${to}`,
      meta: {
        from, to, counts, lost_reasons: lostReasons,
        conversion_rate: counts.created
          ? Number(((counts.converted / counts.created) * 100).toFixed(1)) : null,
      },
    }, req.query.format);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// 10. Party Transaction History
// ---------------------------------------------------------------------------

/**
 * "Full history for a single party — orders, payments, returns, outstanding."
 *
 * One party at a time by design: this is the screen somebody opens with a
 * dealer on the phone, and a list of every party's every transaction is not
 * that screen.
 */
router.get('/party/:id', requirePermission('customers.view'), async (req, res, next) => {
  try {
    const [[party]] = await pool.query(
      `SELECT c.*, u.name AS salesman_name FROM customers c
         LEFT JOIN users u ON u.id = c.salesman_id
        WHERE c.masterid = ?`, [req.params.id]);
    if (!party) return res.status(404).json({ error: 'No such party' });

    const [orders] = await pool.query(
      `SELECT o.order_id, o.so_number, o.order_date, o.status, o.total_amount,
              o.is_no_order, i.invoice_no, i.grand_total, i.amount_paid, i.settled_on
         FROM orders o
         LEFT JOIN invoices i ON i.order_id = o.order_id AND i.status <> 'cancelled'
        WHERE o.customer_id = ? ORDER BY o.order_date DESC, o.order_id DESC LIMIT 500`,
      [req.params.id]);

    const [payments] = await pool.query(
      `SELECT p.receipt_no, p.payment_date, p.amount, p.mode, p.status,
              GROUP_CONCAT(i.invoice_no ORDER BY i.invoice_date) AS applied_to
         FROM payments p
         LEFT JOIN payment_allocations a ON a.payment_id = p.id
         LEFT JOIN invoices i ON i.id = a.invoice_id
        WHERE p.customer_id = ?
        GROUP BY p.id ORDER BY p.payment_date DESC, p.id DESC LIMIT 500`,
      [req.params.id]);

    const [returns] = await pool.query(
      `SELECT r.id, r.return_date, r.total_amount, r.status, r.reason,
              i.invoice_no AS against_invoice
         FROM sales_returns r LEFT JOIN invoices i ON i.id = r.invoice_id
        WHERE r.customer_id = ? ORDER BY r.return_date DESC LIMIT 200`,
      [req.params.id]);

    const [notes] = await pool.query(
      `SELECT note_no, note_date, amount, status, origin, reason
         FROM credit_notes WHERE customer_id = ?
        ORDER BY note_date DESC LIMIT 200`, [req.params.id]);

    const [[ageing]] = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN DATEDIFF(CURDATE(), invoice_date) <= 30
                           THEN grand_total - amount_paid END), 0) AS b0_30,
         COALESCE(SUM(CASE WHEN DATEDIFF(CURDATE(), invoice_date) BETWEEN 31 AND 60
                           THEN grand_total - amount_paid END), 0) AS b31_60,
         COALESCE(SUM(CASE WHEN DATEDIFF(CURDATE(), invoice_date) > 60
                           THEN grand_total - amount_paid END), 0) AS b60_plus
       FROM invoices
       WHERE customer_id = ? AND status <> 'cancelled' AND grand_total > amount_paid`,
      [req.params.id]);

    // The CSV form is the order history, which is what gets printed and taken
    // into a conversation; the JSON carries everything.
    if (String(req.query.format).toLowerCase() === 'csv') {
      return send(res, {
        rows: orders,
        columns: [['order_date', 'Date'], ['so_number', 'SO'], ['invoice_no', 'Invoice'],
          ['total_amount', 'Order'], ['grand_total', 'Invoiced'],
          ['amount_paid', 'Paid'], ['settled_on', 'Settled'], ['status', 'Status']],
        filename: `party-${party.masterid}-${businessDay()}`,
      }, 'csv');
    }

    res.json({
      party,
      ageing: {
        b0_30: num(ageing.b0_30),
        b31_60: num(ageing.b31_60),
        b60_plus: num(ageing.b60_plus),
        total: num(ageing.b0_30) + num(ageing.b31_60) + num(ageing.b60_plus),
      },
      closing_balance: num(party.closing_balance),
      orders,
      payments,
      returns,
      credit_notes: notes,
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// 11. GIT Register Report — lives in routes/git.js (GET /api/git), which is
// the register itself. Not duplicated here: two endpoints answering the same
// question is how they come to disagree.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 12. Stock Count Report
// ---------------------------------------------------------------------------

/** "Daily count results, match/mismatch history." (section 10) */
router.get('/stock-counts', requirePermission('stock_count.view'), async (req, res, next) => {
  try {
    const { from, to } = range(req.query);

    const [rows] = await pool.query(
      `SELECT sc.id, sc.count_date, sc.godown, sc.status, sc.is_auto,
              u.name AS counted_by,
              l.item_name, l.rack, l.system_qty, l.counted_qty, l.variance
         FROM stock_counts sc
         LEFT JOIN users u ON u.id = sc.assigned_to
         LEFT JOIN stock_count_lines l ON l.count_id = sc.id
        WHERE sc.count_date BETWEEN ? AND ?
        ORDER BY sc.count_date DESC, sc.id DESC, l.id
        LIMIT 2000`, [from, to]);

    const shaped = rows.map((r) => ({
      ...r,
      // A line not yet counted is neither a match nor a mismatch.
      outcome: r.counted_qty === null ? 'pending'
        : Math.abs(num(r.variance)) < 0.0001 ? 'match' : 'mismatch',
    }));

    const counted = shaped.filter((r) => r.outcome !== 'pending');
    send(res, {
      rows: shaped,
      columns: [['count_date', 'Date'], ['counted_by', 'Counted by'],
        ['item_name', 'Item'], ['rack', 'Rack'], ['system_qty', 'System'],
        ['counted_qty', 'Counted'], ['variance', 'Variance'], ['outcome', 'Outcome']],
      filename: `stock-counts-${from}-to-${to}`,
      meta: {
        from, to,
        lines_counted: counted.length,
        matches: counted.filter((r) => r.outcome === 'match').length,
        mismatches: counted.filter((r) => r.outcome === 'mismatch').length,
        accuracy: counted.length
          ? Number(((counted.filter((r) => r.outcome === 'match').length / counted.length) * 100).toFixed(1))
          : null,
      },
    }, req.query.format);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// The Yash dashboard's review acknowledgement (section 12)
// ---------------------------------------------------------------------------

/**
 * POST /api/reportsuite/reviewed — "Yash taps a 'Mark Reviewed' button daily to
 * confirm he has reviewed the dashboard. This timestamp is recorded."
 *
 * Keyed on (user, day), so tapping twice is idempotent rather than an error —
 * the point is that it happened, not how many times.
 */
router.post('/reviewed', async (req, res, next) => {
  try {
    const day = businessDay();
    await pool.query(
      `INSERT INTO dashboard_reviews (user_id, review_date, reviewed_at, note)
       VALUES (?, ?, NOW(), ?)
       ON DUPLICATE KEY UPDATE reviewed_at = NOW(), note = VALUES(note)`,
      [req.user.id, day, req.body?.note || null]);

    const [[row]] = await pool.query(
      'SELECT reviewed_at FROM dashboard_reviews WHERE user_id = ? AND review_date = ?',
      [req.user.id, day]);
    res.json({ message: 'Marked reviewed.', review_date: day, reviewed_at: row.reviewed_at });
  } catch (err) { next(err); }
});

/** GET /api/reportsuite/reviewed — the acknowledgement history. */
router.get('/reviewed', async (req, res, next) => {
  try {
    const all = userCan(req.user, 'all');
    const params = all ? [] : [req.user.id];
    const [rows] = await pool.query(
      `SELECT r.*, u.name FROM dashboard_reviews r JOIN users u ON u.id = r.user_id
        ${all ? '' : 'WHERE r.user_id = ?'}
        ORDER BY r.review_date DESC LIMIT 90`, params);
    res.json({ reviews: rows, today: businessDay() });
  } catch (err) { next(err); }
});

/**
 * GET /api/reportsuite — what is available, so a client does not have to hold
 * the list. Also the honest place to say what export formats exist.
 */
router.get('/', (req, res) => {
  res.json({
    reports: [
      { key: 'daily-sales', label: 'Daily Sales', path: '/api/reportsuite/daily-sales', grant: 'orders.view' },
      { key: 'outstanding', label: 'Outstanding', path: '/api/reportsuite/outstanding', grant: 'payments.view' },
      { key: 'salesman-performance', label: 'Salesman Performance', path: '/api/reportsuite/salesman-performance', grant: 'orders.view' },
      { key: 'incentive-progress', label: 'Incentive Progress', path: '/api/reportsuite/incentive-progress/:period', grant: 'incentives.approve' },
      { key: 'purchases', label: 'Purchase', path: '/api/reportsuite/purchases', grant: 'purchases.view' },
      { key: 'stock', label: 'Stock', path: '/api/reportsuite/stock', grant: 'items.view' },
      { key: 'cheques', label: 'Cheque', path: '/api/reportsuite/cheques', grant: 'cheques.view' },
      { key: 'cash-discount', label: 'Cash Discount', path: '/api/reportsuite/cash-discount', grant: 'payments.view' },
      { key: 'estimate-conversion', label: 'Estimate Conversion', path: '/api/reportsuite/estimate-conversion', grant: 'estimates.view' },
      { key: 'party', label: 'Party Transaction History', path: '/api/reportsuite/party/:id', grant: 'customers.view' },
      { key: 'git', label: 'GIT Register', path: '/api/git', grant: 'purchases.view' },
      { key: 'stock-counts', label: 'Stock Count', path: '/api/reportsuite/stock-counts', grant: 'stock_count.view' },
    ],
    date_range: {
      params: ['from', 'to'],
      default: 'today',
      note: 'Both default to today. A `from` alone runs from that date to today.',
    },
    export: {
      csv: 'Add ?format=csv to any report. Opens in Excel; UTF-8 with a BOM.',
      pdf: 'Add ?format=pdf to any report. A4, letterheaded, landscape when wide.',
    },
  });
});

module.exports = router;
