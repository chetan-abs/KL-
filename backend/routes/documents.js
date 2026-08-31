const express = require('express');

const router = express.Router();
const pool = require('../config/db');
const { authenticate, requirePermission } = require('../middleware/auth');
const { numericId } = require('../middleware/params');
const { userCan } = require('../utils/permissions');
const { applyWaivers } = require('../utils/payroll');
const {
  begin, letterhead, hr, facts, table, totals, finish, rupees,
} = require('../utils/pdf');

router.use(authenticate);
numericId(router);

/**
 * The printed documents.
 *
 * Sources: KL_App_Requirements_FINAL.pdf §4.5 (the invoice, in three copies),
 * §7 (the estimate), addendum A.2 (the salary slip). Rules R-21, R-04.
 *
 * Kept apart from `routes/reportsuite.js` because these are not reports. A
 * report is a list somebody reads; these are documents that leave the building
 * — one goes with the goods, one comes back signed, one is handed to an
 * employee. They have letterheads, copy labels, signature blocks and legal
 * content, and they are addressed to somebody.
 */

const PAISE = (n) => Number(n || 0);

// ---------------------------------------------------------------------------
// Invoice — §4.5
// ---------------------------------------------------------------------------

/**
 * GET /api/documents/invoice/:id.pdf — the tax invoice.
 *
 *   "Three copies of the invoice are printed: Original (sent with goods),
 *    Duplicate (driver obtains party signature and returns), Triplicate
 *    (retained in billing file)."
 *
 * All three come out of one request, as three pages of one PDF. Printing them
 * as three separate downloads would let somebody print two, and the whole point
 * of the Duplicate is that it comes back signed — a set that can be partially
 * printed is a set that will be.
 *
 * R-21 is structural here exactly as it is in the billing route: this handler
 * reads `invoices` and `invoice_items` and joins nothing else. There is no
 * agent name or commission figure in scope to print, by construction rather
 * than by remembering not to.
 */
const COPIES = [
  { label: 'ORIGINAL FOR RECIPIENT', note: 'Sent with the goods.' },
  { label: 'DUPLICATE FOR TRANSPORTER', note: 'Driver to obtain the party signature and return this copy.' },
  { label: 'TRIPLICATE FOR SUPPLIER', note: 'Retained in the billing file.' },
];

router.get('/invoice/:id.pdf', requirePermission('billing.view'), async (req, res, next) => {
  try {
    // `:id.pdf` names the param `id`; the `.pdf` is a literal suffix that keeps
    // the URL saveable as a file. numericId() has already rejected a
    // non-numeric one before this runs.
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid invoice id' });

    const [[invoice]] = await pool.query(
      `SELECT i.*, c.address AS party_address, c.city AS party_city,
              c.state AS party_state, c.pincode AS party_pincode, c.phone AS party_phone,
              o.so_number, o.delivered_to, o.delivery_mode, o.payment_mode,
              u.name AS billed_by
         FROM invoices i
         LEFT JOIN customers c ON c.masterid = i.customer_id
         LEFT JOIN orders o    ON o.order_id = i.order_id
         LEFT JOIN users u     ON u.id = i.created_by
        WHERE i.id = ?`, [id]);
    if (!invoice) return res.status(404).json({ error: 'No such invoice' });

    const [lines] = await pool.query(
      'SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id', [id]);

    const doc = begin(res, {
      filename: `invoice-${invoice.invoice_no}`,
      // Inline, because this is printed rather than filed — the browser's own
      // print dialogue is the fastest path to three sheets of paper.
      inline: true,
    });

    COPIES.forEach((copy, index) => {
      if (index > 0) doc.addPage();

      letterhead(doc, {
        title: 'TAX INVOICE',
        subtitle: invoice.invoice_no,
        copyLabel: copy.label,
      });

      facts(doc, [
        ['Party', invoice.party_name],
        ['GSTIN', invoice.party_gstin],
        ['Invoice date', String(invoice.invoice_date).slice(0, 10)],
        ['Address', [invoice.party_address, invoice.party_city, invoice.party_state,
          invoice.party_pincode].filter(Boolean).join(', ')],
        ['Order', invoice.so_number],
        ['Payment', invoice.payment_mode],
        ['Delivered to', invoice.delivered_to],
        ['Mode', invoice.delivery_mode],
        ['Billed by', invoice.billed_by],
      ], 3);

      table(doc, [
        { key: 'n', label: '#', width: 0.05, align: 'right' },
        { key: 'item_name', label: 'Item', width: 0.35 },
        { key: 'hsn', label: 'HSN', width: 0.10 },
        { key: 'qty', label: 'Qty', width: 0.09, align: 'right', format: 'qty' },
        { key: 'rate', label: 'Rate', width: 0.11, align: 'right', format: 'money' },
        { key: 'discount', label: 'Disc %', width: 0.08, align: 'right' },
        { key: 'gst_percent', label: 'GST %', width: 0.08, align: 'right' },
        { key: 'total', label: 'Amount', width: 0.14, align: 'right', format: 'money' },
      ], lines.map((l, i) => ({ ...l, n: i + 1 })), { zebra: false });

      totals(doc, [
        ['Sub-total', PAISE(invoice.sub_total)],
        ['GST', PAISE(invoice.gst_amount)],
        ['Grand total', PAISE(invoice.grand_total), true],
      ]);

      // The signature block. On the Duplicate this is what the driver has the
      // party sign — §4.5 — so it is labelled for the copy it appears on
      // rather than being the same three lines on all three sheets.
      doc.moveDown(1.5);
      const y = doc.y;
      const half = (doc.page.width - doc.page.margins.left - doc.page.margins.right) / 2;
      doc.font('Helvetica').fontSize(7.5).fillColor('#666666');
      doc.text(copy.note, doc.page.margins.left, y, { width: half - 10 });
      doc.text(
        index === 1 ? 'Received the goods in good order:' : 'For K.L. Electricals',
        doc.page.margins.left + half, y, { width: half, align: 'right' });
      doc.moveDown(2.4);
      hr(doc);
      doc.font('Helvetica').fontSize(7).fillColor('#666666');
      doc.text(
        index === 1 ? 'Party signature and stamp' : 'Authorised signatory',
        doc.page.margins.left + half, doc.y + 2, { width: half, align: 'right' });
    });

    finish(doc, { note: `Invoice ${invoice.invoice_no} · three copies · K.L. Electricals` });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Estimate — §7
// ---------------------------------------------------------------------------

/**
 * GET /api/documents/estimate/:id.pdf
 *
 *   "a professionally formatted PDF is generated and can be shared directly via
 *    WhatsApp... The PDF includes item names, quantities, rates, total amount,
 *    validity date, and KL Electricals contact details."
 *
 * All six of those, in that order. The validity date is given prominence
 * because it is the only thing on the document with a deadline attached, and a
 * quote whose expiry the party cannot find is a quote that gets argued about.
 */
router.get('/estimate/:id.pdf', requirePermission('estimates.view'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid estimate id' });

    const [[estimate]] = await pool.query(
      `SELECT e.*, c.name AS party, c.phone, c.address, c.city, c.gst_number,
              u.name AS raised_by
         FROM estimates e
         JOIN customers c ON c.masterid = e.customer_id
         LEFT JOIN users u ON u.id = e.created_by
        WHERE e.id = ?`, [id]);
    if (!estimate) return res.status(404).json({ error: 'No such estimate' });

    // A salesman's own quote, or anyone with the area grant.
    if (estimate.created_by !== req.user.id && !userCan(req.user, 'estimates')) {
      return res.status(403).json({ error: 'That quote belongs to somebody else.' });
    }

    const [lines] = await pool.query(
      'SELECT * FROM estimate_items WHERE estimate_id = ? ORDER BY id', [id]);

    const doc = begin(res, { filename: `quotation-${id}`, inline: true });

    letterhead(doc, { title: 'QUOTATION', subtitle: `No. ${id}` });

    facts(doc, [
      ['For', estimate.party],
      ['Date', String(estimate.estimate_date).slice(0, 10)],
      ['Valid until', estimate.valid_until ? String(estimate.valid_until).slice(0, 10) : '—'],
      ['Contact', estimate.phone],
      ['Address', [estimate.address, estimate.city].filter(Boolean).join(', ')],
      ['Raised by', estimate.raised_by],
    ], 3);

    table(doc, [
      { key: 'n', label: '#', width: 0.06, align: 'right' },
      { key: 'item_name', label: 'Item', width: 0.50 },
      { key: 'qty', label: 'Qty', width: 0.12, align: 'right', format: 'qty' },
      { key: 'rate', label: 'Rate', width: 0.15, align: 'right', format: 'money' },
      { key: 'total', label: 'Amount', width: 0.17, align: 'right', format: 'money' },
    ], lines.map((l, i) => ({ ...l, n: i + 1 })), { zebra: false });

    totals(doc, [['Total', PAISE(estimate.total_amount), true]]);

    doc.moveDown(1);
    doc.font('Helvetica').fontSize(7.5).fillColor('#666666');
    doc.text(
      `Rates are valid until ${estimate.valid_until ? String(estimate.valid_until).slice(0, 10) : 'the date above'}`
      + ' and exclude GST unless stated. Subject to stock availability at the time of order.');

    finish(doc, { note: 'K.L. Electricals · Lakhtokia, Guwahati · 9365080150' });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Salary slip — addendum A.2
// ---------------------------------------------------------------------------

/**
 * GET /api/documents/salary-slip/:employeeId/:period.pdf
 *
 *   "It shows: Employee name, month, fixed salary, itemised deductions (advance
 *    recovery, late deductions, half-day deductions, absence deductions), and
 *    net payable amount."
 *
 * Only a FINALISED month has a slip. A draft recomputes on every read, so a
 * slip taken from one would be a different document tomorrow — and a payslip
 * that changes after it is issued is worse than none at all.
 *
 * An employee may print their own without any grant, and nobody else's: "This
 * ledger is visible to Yash, Manoj, and the employee themselves."
 */
const DEDUCTION_LABELS = {
  late: 'Late arrivals',
  half_day: 'Half days',
  absent_informed: 'Absent — leave approved',
  absent_uninformed: 'Absent without information',
  advance: 'Advance recovery',
  other: 'Other deductions',
};

router.get('/salary-slip/:employeeId/:period.pdf', async (req, res, next) => {
  try {
    const { employeeId } = req.params;
    const period = String(req.params.period);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
      return res.status(400).json({ error: 'Period must be YYYY-MM.' });
    }

    const manages = userCan(req.user, 'salary') || userCan(req.user, 'salary.manage');
    if (employeeId !== req.user.id && !manages) {
      return res.status(403).json({ error: 'That is somebody else\'s slip.' });
    }

    const [[row]] = await pool.query(
      `SELECT p.*, u.name AS employee_name, u.shift_code, a.name AS approved_by_name
         FROM salary_periods p
         JOIN users u ON u.id = p.employee_id
         LEFT JOIN users a ON a.id = p.approved_by
        WHERE p.employee_id = ? AND p.period = ?`, [employeeId, period]);

    if (!row || row.status === 'draft') {
      return res.status(row ? 409 : 404).json({
        error: 'That month has not been finalised, so there is no slip to print.',
        code: 'NOT_FINALISED',
      });
    }

    const [lines] = await pool.query(
      `SELECT kind, amount, waived FROM salary_deductions WHERE period_id = ?`, [row.id]);
    const t = applyWaivers(row, lines);

    const grouped = new Map();
    for (const l of lines.filter((x) => !x.waived)) {
      const g = grouped.get(l.kind) || { kind: l.kind, count: 0, amount: 0 };
      g.count += 1;
      g.amount = Math.round((g.amount + Number(l.amount)) * 100) / 100;
      grouped.set(l.kind, g);
    }

    const doc = begin(res, { filename: `salary-slip-${employeeId}-${period}`, inline: true });

    letterhead(doc, { title: 'SALARY SLIP', subtitle: period });

    facts(doc, [
      ['Employee', row.employee_name],
      ['Employee ID', employeeId],
      ['Shift', row.shift_code || '—'],
      ['Month', period],
      ['Working days', row.working_days],
      ['Days present', row.days_present],
      ['Late arrivals', row.days_late],
      ['Half days', row.half_days],
      ['Absent', Number(row.days_absent_informed) + Number(row.days_absent_uninformed)],
    ], 3);

    table(doc, [
      { key: 'label', label: 'Earnings and deductions', width: 0.55 },
      { key: 'count', label: 'Count', width: 0.15, align: 'right' },
      { key: 'amount', label: 'Amount', width: 0.30, align: 'right', format: 'money' },
    ], [
      { label: 'Fixed salary (gross)', count: null, amount: PAISE(row.fixed_salary) },
      ...[...grouped.values()].map((g) => ({
        label: `Less: ${DEDUCTION_LABELS[g.kind] || g.kind}`,
        count: g.count,
        amount: -g.amount,
      })),
    ], { zebra: false });

    totals(doc, [
      ['Total deductions',
        -(t.attendance_deduction + t.advance_deduction + t.other_deduction)],
      ['NET PAYABLE', t.net_payable, true],
    ]);

    // A waived deduction stays on the slip. It was earned and then forgiven,
    // and both are facts the employee is entitled to see — hiding the waiver
    // would make the arithmetic look wrong.
    const waived = lines.filter((l) => l.waived);
    if (waived.length) {
      doc.moveDown(0.8);
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#111111')
        .text(`Waived by management (${waived.length})`);
      doc.font('Helvetica').fontSize(7.5).fillColor('#666666')
        .text(`${rupees(waived.reduce((a, l) => a + Number(l.amount), 0))} of deductions were `
          + 'recorded and then waived. They are shown here for completeness and are not '
          + 'included in the total above.');
    }

    doc.moveDown(1);
    doc.font('Helvetica').fontSize(7.5).fillColor('#666666').text(
      `Daily rate ${rupees(row.daily_rate)} (fixed salary / 26 working days). `
      + `${row.status === 'paid' ? `Paid on ${String(row.paid_on).slice(0, 10)}.` : `Status: ${row.status}.`}`
      + `${row.approved_by_name ? ` Approved by ${row.approved_by_name}.` : ''}`);

    finish(doc, { note: `Salary slip · ${row.employee_name} · ${period} · K.L. Electricals` });
  } catch (err) { next(err); }
});

module.exports = router;
