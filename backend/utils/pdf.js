/**
 * PDF rendering.
 *
 * Sources: KL_App_Requirements_FINAL.pdf §12 ("All reports must be exportable
 * as PDF and Excel"), §4.5 (three invoice copies), §7 (the estimate PDF),
 * addendum A.2 (the salary slip).
 *
 * Built on `pdfkit` — a streaming, dependency-light generator with no headless
 * browser behind it. The alternative was rendering HTML through Chromium, which
 * would put a 200 MB browser and a process pool into an app whose whole PDF
 * requirement is four documents made of text and rules.
 *
 * Everything here streams to the response rather than buffering. A stock report
 * over 8,900 items is a large document, and holding it in memory to measure its
 * length before sending is how a report endpoint takes the process down.
 *
 * ---------------------------------------------------------------------------
 * The letterhead is data, not a logo file
 * ---------------------------------------------------------------------------
 * The details come from `KL_App_Requirements_FINAL.pdf` §1 and the footer of
 * its own pages. There is no image: `assets/` holds the ABS logo rather than a
 * KL Electricals mark (see CLAUDE.md), and putting the wrong company's logo on
 * a GST invoice is worse than putting none.
 */

const PDFDocument = require('pdfkit');

const LETTERHEAD = {
  name: 'K.L. ELECTRICALS',
  lines: [
    'Lakhtokia, Guwahati, Assam',
    'GSTIN/UIN: 18ABQPA9261Q1ZU',
    'Phone: 9365080150 · klelectricals@gmail.com',
  ],
};

/** A4 with margins wide enough to survive a cheap printer's unprintable edge. */
const PAGE = { size: 'A4', margins: { top: 42, bottom: 48, left: 40, right: 40 } };

const GREY = '#666666';
const RULE = '#cccccc';
const INK = '#111111';

const rupees = (n) => Number(n || 0).toLocaleString('en-IN', {
  minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Start a document and stream it at the caller.
 *
 * `filename` decides what the browser saves it as. `inline` is for a print
 * preview; the default is an attachment, because every one of these is a
 * document somebody wants on disk.
 */
function begin(res, { filename, inline = false, layout = 'portrait' }) {
  const doc = new PDFDocument({ ...PAGE, layout, bufferPages: true });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename="${filename}.pdf"`);
  doc.pipe(res);
  return doc;
}

/** The letterhead block, and the document's own title beside it. */
function letterhead(doc, { title, subtitle, copyLabel }) {
  const top = doc.y;

  doc.fillColor(INK).font('Helvetica-Bold').fontSize(15).text(LETTERHEAD.name, { continued: false });
  doc.font('Helvetica').fontSize(8).fillColor(GREY);
  for (const line of LETTERHEAD.lines) doc.text(line);

  // The title sits on the right of the same band. Positioned absolutely because
  // pdfkit's flow would otherwise put it under the address.
  const right = doc.page.width - doc.page.margins.right;
  doc.font('Helvetica-Bold').fontSize(13).fillColor(INK)
    .text(title, doc.page.margins.left, top, { width: right - doc.page.margins.left, align: 'right' });
  if (subtitle) {
    doc.font('Helvetica').fontSize(8).fillColor(GREY)
      .text(subtitle, doc.page.margins.left, doc.y, {
        width: right - doc.page.margins.left, align: 'right' });
  }
  if (copyLabel) {
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#8a1f1f')
      .text(copyLabel, doc.page.margins.left, doc.y + 2, {
        width: right - doc.page.margins.left, align: 'right' });
  }

  doc.moveDown(0.6);
  hr(doc);
  doc.moveDown(0.5);
  doc.fillColor(INK);
}

function hr(doc) {
  const y = doc.y;
  doc.strokeColor(RULE).lineWidth(0.6)
    .moveTo(doc.page.margins.left, y)
    .lineTo(doc.page.width - doc.page.margins.right, y)
    .stroke();
  doc.y = y + 2;
}

/** A label-value block, two or three across. */
function facts(doc, pairs, columns = 3) {
  const usable = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colWidth = usable / columns;
  let x = doc.page.margins.left;
  const startY = doc.y;
  let maxY = startY;

  pairs.forEach((pair, i) => {
    if (i > 0 && i % columns === 0) {
      x = doc.page.margins.left;
      doc.y = maxY + 4;
    }
    const y = doc.y;
    doc.font('Helvetica').fontSize(7).fillColor(GREY)
      .text(String(pair[0]).toUpperCase(), x, y, { width: colWidth - 8 });
    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK)
      .text(pair[1] === null || pair[1] === undefined || pair[1] === '' ? '—' : String(pair[1]),
        x, doc.y, { width: colWidth - 8 });
    maxY = Math.max(maxY, doc.y);
    doc.y = y;
    x += colWidth;
  });

  doc.y = maxY + 8;
  doc.x = doc.page.margins.left;
}

/**
 * A table.
 *
 * `columns` is `[{ key, label, width, align, format }]`. Widths are FRACTIONS
 * of the usable width, not points, so the same table definition works in
 * portrait and landscape — which the wide reports need.
 *
 * Repeats the header on every page. A twelve-page stock report whose columns are
 * only labelled on page one is a report nobody can read past page one.
 */
function table(doc, columns, rows, { zebra = true, onNewPage } = {}) {
  const usable = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const widths = columns.map((c) => (c.width || 1 / columns.length) * usable);

  const header = () => {
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(GREY);
    let x = doc.page.margins.left;
    columns.forEach((c, i) => {
      doc.text(String(c.label).toUpperCase(), x + 2, y, {
        width: widths[i] - 4, align: c.align || 'left', lineBreak: false });
      x += widths[i];
    });
    doc.y = y + 11;
    hr(doc);
    doc.y += 2;
  };

  header();

  const bottom = doc.page.height - doc.page.margins.bottom - 24;
  let striped = false;

  for (const row of rows) {
    // Measured before drawing, so a tall wrapped cell does not straddle a page
    // break with half its text on each side.
    doc.font('Helvetica').fontSize(8);
    const heights = columns.map((c, i) => doc.heightOfString(
      formatCell(c, row), { width: widths[i] - 4 }));
    const rowHeight = Math.max(11, ...heights);

    if (doc.y + rowHeight > bottom) {
      doc.addPage();
      if (onNewPage) onNewPage(doc);
      header();
      striped = false;
    }

    const y = doc.y;
    if (zebra && striped) {
      doc.rect(doc.page.margins.left, y - 1.5, usable, rowHeight + 2)
        .fillColor('#f6f6f6').fill();
    }
    striped = !striped;

    let x = doc.page.margins.left;
    doc.font('Helvetica').fontSize(8).fillColor(INK);
    columns.forEach((c, i) => {
      doc.text(formatCell(c, row), x + 2, y, {
        width: widths[i] - 4, align: c.align || 'left' });
      x += widths[i];
    });
    doc.y = y + rowHeight + 2;
  }

  hr(doc);
  doc.y += 2;
}

function formatCell(column, row) {
  const raw = row[column.key];
  if (column.format === 'money') return rupees(raw);
  if (column.format === 'qty') return raw === null || raw === undefined ? '—' : String(Number(raw));
  if (column.format === 'date') return raw ? String(raw).slice(0, 10) : '—';
  if (raw === null || raw === undefined || raw === '') return '—';
  if (typeof raw === 'boolean') return raw ? 'Yes' : 'No';
  return String(raw);
}

/** A right-aligned totals block. */
function totals(doc, pairs) {
  const right = doc.page.width - doc.page.margins.right;
  const width = 220;
  const x = right - width;
  doc.moveDown(0.3);

  pairs.forEach(([label, value, emphasis]) => {
    const y = doc.y;
    doc.font(emphasis ? 'Helvetica-Bold' : 'Helvetica').fontSize(emphasis ? 10 : 8.5)
      .fillColor(emphasis ? INK : GREY)
      .text(label, x, y, { width: width - 90, align: 'right' });
    doc.font('Helvetica-Bold').fontSize(emphasis ? 10 : 8.5).fillColor(INK)
      .text(rupees(value), x + width - 88, y, { width: 88, align: 'right' });
    doc.y = y + (emphasis ? 14 : 11);
  });
  doc.x = doc.page.margins.left;
}

/**
 * Page numbers and the generation stamp, on every page.
 *
 * Written at the end over buffered pages, because "Page 1 of 7" cannot be known
 * until the seventh page exists. Without `bufferPages` this is the footer that
 * says "of 1" on a twelve-page report.
 */
function finish(doc, { note } = {}) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    const y = doc.page.height - doc.page.margins.bottom + 12;
    doc.font('Helvetica').fontSize(7).fillColor(GREY);
    doc.text(note || `Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
      doc.page.margins.left, y, { lineBreak: false });
    doc.text(`Page ${i - range.start + 1} of ${range.count}`,
      doc.page.margins.left, y,
      { width: doc.page.width - doc.page.margins.left - doc.page.margins.right, align: 'right' });
  }
  doc.end();
}

/**
 * A generic report PDF, used by every §12 report.
 *
 * Landscape when there are more than seven columns: the wide reports —
 * salesman performance, purchases — are unreadable squeezed into portrait, and
 * choosing per report would mean each one deciding again.
 */
function report(res, { title, subtitle, filename, columns, rows, meta = [], summary = [] }) {
  const wide = columns.length > 7;
  const doc = begin(res, { filename, layout: wide ? 'landscape' : 'portrait' });

  letterhead(doc, { title, subtitle });
  if (meta.length) facts(doc, meta, Math.min(4, meta.length));

  if (!rows.length) {
    doc.font('Helvetica-Oblique').fontSize(9).fillColor(GREY)
      .text('No records in this period.');
  } else {
    table(doc, columns, rows, {
      onNewPage: (d) => letterhead(d, { title, subtitle: `${subtitle || ''} (continued)`.trim() }),
    });
  }

  if (summary.length) totals(doc, summary);
  finish(doc);
}

module.exports = {
  LETTERHEAD,
  begin,
  letterhead,
  hr,
  facts,
  table,
  totals,
  finish,
  report,
  rupees,
};
