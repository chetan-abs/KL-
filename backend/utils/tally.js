/**
 * Tally Prime synchronisation.
 *
 * Source: KL_App_Requirements_FINAL.pdf section 14 — "real-time bidirectional
 * synchronisation with Tally Prime. The technical method of integration is at
 * the development team's discretion."
 *
 * The method chosen is Tally's own HTTP/XML gateway. Tally Prime listens on
 * port 9000 when Gateway of Tally → F1 → Advanced Configuration → "Act as
 * Server" is Yes, and accepts a `<ENVELOPE>` of TDL requests over plain POST.
 * No ODBC driver, no shared folder, no third-party connector — one HTTP call
 * and a text format, both of which can be debugged with curl and read by eye.
 *
 * ---------------------------------------------------------------------------
 * The three decisions that shape this file
 * ---------------------------------------------------------------------------
 *
 * 1. Every outbound document goes through an OUTBOX (`tally_queue`), enqueued
 *    in the same transaction as the business write. Tally lives on an office
 *    desktop that is closed at night, during backups and whenever somebody
 *    reboots. Pushing inline would either fail the invoice — refusing to bill
 *    because an accounting package is shut — or lose it silently, which is
 *    worse. "Real-time" therefore means the worker runs continuously, not that
 *    an HTTP call blocks a salesman at a shop counter.
 *
 * 2. Nothing is bidirectional PER RECORD. Section 14's nine App→Tally flows and
 *    six Tally→App flows cover different entities: we author documents, Tally
 *    authors masters. That is what removes the need for conflict resolution,
 *    and it is why there is no "last write wins" anywhere here.
 *
 * 3. Tally's stock and balance figures are RECONCILED, never applied.
 *    `items.qty` and `customers.closing_balance` are caches of our own ledgers.
 *    Writing Tally's number into them would break that on the first pull, and
 *    then no figure in the app could be explained again. A pull lands in
 *    `tally_reconciliation` as a comparison; a variance is a finding for a
 *    person, which is what "sync" can honestly mean for a derived figure.
 */

const http = require('http');
const crypto = require('crypto');

const { money, qty } = require('./workflow');

/** Where Tally is, and whether we are meant to be talking to it at all. */
function config() {
  return {
    host: process.env.TALLY_HOST || '127.0.0.1',
    port: Number(process.env.TALLY_PORT || 9000),
    // The company name exactly as Tally shows it. Tally routes every request by
    // this, and a mismatch is silently answered with "No Company" rather than
    // an error, so it is required rather than defaulted.
    company: process.env.TALLY_COMPANY || '',
    timeoutMs: Number(process.env.TALLY_TIMEOUT_MS || 15000),
    // Off by default. A half-configured sync that pushes documents into the
    // wrong company is worse than no sync, and this must be switched on
    // deliberately once TALLY_COMPANY is known to be right.
    enabled: process.env.TALLY_ENABLED === 'true',
  };
}

/**
 * XML escaping.
 *
 * Party names come out of a database and go into a markup document, which is
 * the same shape of problem as the map popup in `components/LeafletMap.js`: a
 * name containing `&` or `<` is not a string to be concatenated. Tally is
 * particularly unforgiving — a stray ampersand makes it reject the whole
 * envelope with a parse error that names no document.
 */
function xml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Tally wants dates as YYYYMMDD with no separators. */
const tallyDate = (d) => String(d || '').slice(0, 10).replace(/-/g, '');

/**
 * A request envelope.
 *
 * `IMPORT`/`ALL MASTERS` is the shape Tally accepts for both masters and
 * vouchers — it decides which by the tag inside TALLYMESSAGE, not by the
 * request type, which is why one wrapper serves everything.
 */
function importEnvelope(company, body) {
  return `<ENVELOPE>
 <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
 <BODY>
  <IMPORTDATA>
   <REQUESTDESC>
    <REPORTNAME>All Masters</REPORTNAME>
    <STATICVARIABLES><SVCURRENTCOMPANY>${xml(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
   </REQUESTDESC>
   <REQUESTDATA>
${body}
   </REQUESTDATA>
  </IMPORTDATA>
 </BODY>
</ENVELOPE>`;
}

/** An export (read) envelope, for the Tally→App direction. */
function exportEnvelope(company, reportName, extra = '') {
  return `<ENVELOPE>
 <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
 <BODY>
  <EXPORTDATA>
   <REQUESTDESC>
    <REPORTNAME>${xml(reportName)}</REPORTNAME>
    <STATICVARIABLES>
     <SVCURRENTCOMPANY>${xml(company)}</SVCURRENTCOMPANY>
     <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
${extra}
    </STATICVARIABLES>
   </REQUESTDESC>
  </EXPORTDATA>
 </BODY>
</ENVELOPE>`;
}

// ---------------------------------------------------------------------------
// Voucher builders — the nine App→Tally flows of section 14
// ---------------------------------------------------------------------------

/**
 * A ledger entry pair. Tally is double-entry: every voucher's AMOUNTs must sum
 * to zero, with negative meaning debit. Getting the sign wrong does not fail —
 * Tally accepts it and the trial balance is wrong, which is the worst kind of
 * bug to have in an accounting integration.
 */
function ledgerEntry({ name, amount, isDeemedPositive }) {
  return `     <ALLLEDGERENTRIES.LIST>
      <LEDGERNAME>${xml(name)}</LEDGERNAME>
      <ISDEEMEDPOSITIVE>${isDeemedPositive ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>
      <AMOUNT>${amount}</AMOUNT>
     </ALLLEDGERENTRIES.LIST>`;
}

function inventoryEntry({ itemName, qty: quantity, rate, amount, unit, godown }) {
  return `     <ALLINVENTORYENTRIES.LIST>
      <STOCKITEMNAME>${xml(itemName)}</STOCKITEMNAME>
      <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
      <RATE>${rate}/${xml(unit || 'Nos')}</RATE>
      <AMOUNT>${amount}</AMOUNT>
      <ACTUALQTY>${quantity} ${xml(unit || 'Nos')}</ACTUALQTY>
      <BILLEDQTY>${quantity} ${xml(unit || 'Nos')}</BILLEDQTY>
      <BATCHALLOCATIONS.LIST>
       <GODOWNNAME>${xml(godown || 'Main Location')}</GODOWNNAME>
       <BATCHNAME>Primary Batch</BATCHNAME>
       <ACTUALQTY>${quantity} ${xml(unit || 'Nos')}</ACTUALQTY>
       <BILLEDQTY>${quantity} ${xml(unit || 'Nos')}</BILLEDQTY>
       <AMOUNT>${amount}</AMOUNT>
      </BATCHALLOCATIONS.LIST>
     </ALLINVENTORYENTRIES.LIST>`;
}

/**
 * Wrap a voucher.
 *
 * `remoteKey` is our own document number used as Tally's VOUCHERKEY, which is
 * what makes a re-push an amendment rather than a duplicate — the single most
 * important property of an accounting sync. Without it, retrying a push that
 * timed out after Tally had already committed produces two invoices for one
 * sale, and the month never balances again.
 */
function voucher({ type, number, date, remoteKey, narration, entries, inventory = [], extra = '' }) {
  return `    <TALLYMESSAGE xmlns:UDF="TallyUDF">
     <VOUCHER VCHTYPE="${xml(type)}" ACTION="Alter" OBJVIEW="${
  inventory.length ? 'Invoice Voucher View' : 'Accounting Voucher View'}">
      <REMOTEID>${xml(remoteKey)}</REMOTEID>
      <VOUCHERTYPENAME>${xml(type)}</VOUCHERTYPENAME>
      <VOUCHERNUMBER>${xml(number)}</VOUCHERNUMBER>
      <DATE>${tallyDate(date)}</DATE>
      <EFFECTIVEDATE>${tallyDate(date)}</EFFECTIVEDATE>
      <NARRATION>${xml(narration || '')}</NARRATION>
${extra}
${entries.join('\n')}
${inventory.join('\n')}
     </VOUCHER>
    </TALLYMESSAGE>`;
}

/** Sales Order — pushed on approval (section 14, and R-01 is the trigger). */
function salesOrderXml({ order, lines, company }) {
  const total = money(order.total_amount);
  return importEnvelope(company, voucher({
    type: 'Sales Order',
    number: order.so_number || `SO-${order.order_id}`,
    date: order.order_date,
    remoteKey: `KL-SO-${order.order_id}`,
    narration: `Sales order for ${order.party_name}`,
    entries: [
      ledgerEntry({ name: order.party_name, amount: -total, isDeemedPositive: true }),
      ledgerEntry({ name: process.env.TALLY_SALES_LEDGER || 'Sales', amount: total, isDeemedPositive: false }),
    ],
    inventory: lines.map((l) => inventoryEntry({
      itemName: l.item_name,
      qty: qty(l.qty),
      rate: money(l.rate),
      amount: money(l.total),
      unit: l.unit,
    })),
  }));
}

/**
 * Sales Invoice — pushed on creation.
 *
 * R-21: "Commission agent names and commission amounts do not appear on any
 * invoice." The guarantee here is the same structural one the print carries —
 * nothing in this function reads `agent_id` or `agent_commission`, and there is
 * no reason for it to. Do not add a UDF "for reporting".
 */
function salesInvoiceXml({ invoice, lines, company }) {
  const sub = money(invoice.sub_total);
  const gst = money(invoice.gst_amount);
  const total = money(invoice.grand_total);

  const entries = [
    ledgerEntry({ name: invoice.party_name, amount: -total, isDeemedPositive: true }),
    ledgerEntry({ name: process.env.TALLY_SALES_LEDGER || 'Sales', amount: sub, isDeemedPositive: false }),
  ];
  if (gst > 0) {
    entries.push(ledgerEntry({
      name: process.env.TALLY_GST_LEDGER || 'Output GST', amount: gst, isDeemedPositive: false }));
  }

  return importEnvelope(company, voucher({
    type: 'Sales',
    number: invoice.invoice_no,
    date: invoice.invoice_date,
    remoteKey: `KL-INV-${invoice.id}`,
    narration: `Invoice ${invoice.invoice_no}`,
    extra: `      <PARTYGSTIN>${xml(invoice.party_gstin || '')}</PARTYGSTIN>
      <PARTYLEDGERNAME>${xml(invoice.party_name)}</PARTYLEDGERNAME>`,
    entries,
    inventory: lines.map((l) => inventoryEntry({
      itemName: l.item_name,
      qty: qty(l.qty),
      rate: money(l.rate),
      amount: money(l.total - (l.gst_amount || 0)),
      unit: l.unit,
    })),
  }));
}

/** Credit Note — pushed on approval, whether from a return or a cash discount. */
function creditNoteXml({ note, company }) {
  const amount = money(note.amount);
  return importEnvelope(company, voucher({
    type: 'Credit Note',
    number: note.note_no,
    date: note.note_date,
    remoteKey: `KL-CN-${note.id}`,
    narration: note.reason || 'Credit note',
    entries: [
      ledgerEntry({ name: process.env.TALLY_SALES_LEDGER || 'Sales', amount: -amount, isDeemedPositive: true }),
      ledgerEntry({ name: note.party_name, amount, isDeemedPositive: false }),
    ],
  }));
}

/**
 * Purchase Voucher — pushed after Sonu's verification (section 14 is explicit:
 * "after Sonu verification"), and Registered or Unregistered depending on
 * whether a GST bill was in hand.
 */
function purchaseXml({ purchase, lines, company, registered }) {
  const sub = money(purchase.sub_total);
  const gst = money(purchase.gst_amount);
  const total = money(purchase.grand_total);

  const entries = [
    ledgerEntry({ name: process.env.TALLY_PURCHASE_LEDGER || 'Purchase', amount: -sub, isDeemedPositive: true }),
  ];
  if (registered && gst > 0) {
    entries.push(ledgerEntry({
      name: process.env.TALLY_INPUT_GST_LEDGER || 'Input GST', amount: -gst, isDeemedPositive: true }));
  }
  entries.push(ledgerEntry({ name: purchase.supplier_name, amount: total, isDeemedPositive: false }));

  return importEnvelope(company, voucher({
    type: 'Purchase',
    number: purchase.invoice_no || purchase.challan_no || `PUR-${purchase.id}`,
    date: purchase.purchase_date,
    remoteKey: `KL-PUR-${purchase.id}`,
    narration: registered
      ? `Purchase ${purchase.invoice_no || ''}`.trim()
      : `Unregistered purchase against challan ${purchase.challan_no || ''}`.trim(),
    entries,
    // Billed on what was COUNTED, not what the supplier's bill said — R-08's
    // consequence follows the goods all the way into Tally.
    inventory: lines.map((l) => inventoryEntry({
      itemName: l.item_name,
      qty: qty(l.qty),
      rate: money(l.rate),
      amount: money(l.total),
      unit: l.unit,
    })),
  }));
}

/** Stock Journal for an internal transfer — R-14, due the same day. */
function stockJournalXml({ transfer, lines, company }) {
  const consumption = lines.map((l) => `     <ALLINVENTORYENTRIES.LIST>
      <STOCKITEMNAME>${xml(l.item_name)}</STOCKITEMNAME>
      <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
      <ACTUALQTY>-${qty(l.sent_qty)}</ACTUALQTY>
      <BATCHALLOCATIONS.LIST>
       <GODOWNNAME>${xml(transfer.from_godown)}</GODOWNNAME>
       <BATCHNAME>Primary Batch</BATCHNAME>
       <ACTUALQTY>-${qty(l.sent_qty)}</ACTUALQTY>
      </BATCHALLOCATIONS.LIST>
     </ALLINVENTORYENTRIES.LIST>`);

  const production = lines.map((l) => `     <ALLINVENTORYENTRIES.LIST>
      <STOCKITEMNAME>${xml(l.item_name)}</STOCKITEMNAME>
      <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
      <ACTUALQTY>${qty(l.received_qty ?? l.sent_qty)}</ACTUALQTY>
      <BATCHALLOCATIONS.LIST>
       <GODOWNNAME>${xml(transfer.to_godown)}</GODOWNNAME>
       <BATCHNAME>Primary Batch</BATCHNAME>
       <ACTUALQTY>${qty(l.received_qty ?? l.sent_qty)}</ACTUALQTY>
      </BATCHALLOCATIONS.LIST>
     </ALLINVENTORYENTRIES.LIST>`);

  return importEnvelope(company, voucher({
    type: 'Stock Journal',
    number: transfer.transfer_no,
    date: transfer.transfer_date,
    remoteKey: `KL-IT-${transfer.id}`,
    narration: `Transfer ${transfer.from_godown} to ${transfer.to_godown}`,
    entries: [],
    inventory: [...consumption, ...production],
  }));
}

/** Receipt — money in against a party. */
function receiptXml({ payment, company }) {
  const amount = money(payment.amount);
  const bank = payment.mode === 'cash'
    ? (process.env.TALLY_CASH_LEDGER || 'Cash')
    : (process.env.TALLY_BANK_LEDGER || 'Bank');

  return importEnvelope(company, voucher({
    type: 'Receipt',
    number: payment.receipt_no,
    date: payment.payment_date,
    remoteKey: `KL-RC-${payment.id}`,
    narration: `Receipt ${payment.receipt_no} from ${payment.party_name}`,
    entries: [
      ledgerEntry({ name: bank, amount: -amount, isDeemedPositive: true }),
      ledgerEntry({ name: payment.party_name, amount, isDeemedPositive: false }),
    ],
  }));
}

/**
 * A party, as a Tally ledger under Sundry Debtors.
 *
 * Tally identifies a ledger by NAME — there is no id to address it by — so the
 * element's NAME attribute is the LOOKUP and `<NAME.LIST>` is what it becomes.
 * Passing the same string for both is an ordinary update.
 *
 * `previousName` is what makes a RENAME work. Without it, changing a party's
 * name here produced a SECOND ledger in Tally: the alter matched nothing under
 * the new name, so Tally created it, and the old one sat there holding all the
 * history. Pass the name Tally currently knows — `tally_links.tally_name` — and
 * the alter finds the existing ledger and renames it in place.
 */
function ledgerMasterXml({ customer, company, previousName = null }) {
  const lookup = previousName || customer.name;
  return importEnvelope(company, `    <TALLYMESSAGE xmlns:UDF="TallyUDF">
     <LEDGER NAME="${xml(lookup)}" ACTION="Alter">
      <NAME.LIST TYPE="String"><NAME>${xml(customer.name)}</NAME></NAME.LIST>
      <NAME>${xml(customer.name)}</NAME>
      <PARENT>${xml(process.env.TALLY_DEBTOR_GROUP || 'Sundry Debtors')}</PARENT>
      <ISBILLWISEON>Yes</ISBILLWISEON>
      <AFFECTSSTOCK>No</AFFECTSSTOCK>
      <PARTYGSTIN>${xml(customer.gst_number || '')}</PARTYGSTIN>
      <LEDGERPHONE>${xml(customer.phone || '')}</LEDGERPHONE>
      <ADDRESS.LIST><ADDRESS>${xml(customer.address || '')}</ADDRESS></ADDRESS.LIST>
      <LEDSTATENAME>${xml(customer.state || '')}</LEDSTATENAME>
      <PINCODE>${xml(customer.pincode || '')}</PINCODE>
     </LEDGER>
    </TALLYMESSAGE>`);
}

/** A new item, as a Tally stock item. */
function itemMasterXml({ item, company }) {
  return importEnvelope(company, `    <TALLYMESSAGE xmlns:UDF="TallyUDF">
     <STOCKITEM NAME="${xml(item.name)}" ACTION="Alter">
      <NAME>${xml(item.name)}</NAME>
      <PARENT>${xml(item.brand || process.env.TALLY_ITEM_GROUP || 'Primary')}</PARENT>
      <BASEUNITS>${xml(item.unit || 'Nos')}</BASEUNITS>
      <GSTAPPLICABLE>${item.gst_percent > 0 ? 'Applicable' : 'Not Applicable'}</GSTAPPLICABLE>
      <HSNCODE>${xml(item.hsn || '')}</HSNCODE>
     </STOCKITEM>
    </TALLYMESSAGE>`);
}

// ---------------------------------------------------------------------------
// The outbox
// ---------------------------------------------------------------------------

/**
 * Enqueue a document for Tally, inside the caller's transaction.
 *
 * Never throws into that transaction. A sync that cannot be queued must not
 * roll back the invoice it was announcing — the same rule `notify()` follows,
 * and for the same reason: the business fact happened whether or not the
 * accounting package hears about it today. A failure is logged and the document
 * is visible as un-synced on the Tally status screen.
 */
async function enqueue(conn, { kind, refType, refId, payload, userId = null }) {
  if (!payload) return false;
  try {
    await conn.query(
      `INSERT INTO tally_queue (kind, ref_type, ref_id, payload, enqueued_by)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         payload = VALUES(payload),
         -- A document re-enqueued after an edit goes back to pending rather
         -- than staying 'sent': Tally has the old version and needs the new.
         status = 'pending', attempts = 0, last_error = NULL,
         next_attempt_at = NULL, enqueued_at = NOW()`,
      [kind, refType, refId, payload, userId],
    );
    return true;
  } catch (err) {
    console.error(`[TALLY] could not queue ${kind} ${refType}#${refId}: ${err.sqlMessage || err.message}`);
    return false;
  }
}

/**
 * POST an envelope to Tally.
 *
 * Uses `http` directly rather than a client library: this is one POST of text
 * to a host on the office LAN, and a dependency for it would be a dependency to
 * audit. `reachable: false` is distinguished from a rejection because the
 * difference between "Tally is switched off" and "Tally refused our invoice" is
 * the entire diagnosis.
 */
function post(envelope) {
  const { host, port, timeoutMs } = config();

  return new Promise((resolve) => {
    const body = Buffer.from(envelope, 'utf8');
    const req = http.request({
      host,
      port,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'Content-Length': body.length,
      },
      timeout: timeoutMs,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve(interpret(res.statusCode, text)));
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({
        ok: false,
        reachable: false,
        error: `Tally did not answer within ${timeoutMs}ms at ${host}:${port}.`,
      });
    });
    req.on('error', (err) => resolve({
      ok: false,
      reachable: false,
      error: `${err.code || 'ERROR'} contacting Tally at ${host}:${port} — ${err.message}`,
    }));

    req.write(body);
    req.end();
  });
}

/**
 * Read Tally's answer.
 *
 * Tally returns HTTP 200 for a rejected import as readily as for an accepted
 * one; the outcome is inside the XML, in `<CREATED>`, `<ALTERED>`, `<ERRORS>`
 * and `<LINEERROR>`. Treating 200 as success is the classic way to build a sync
 * that reports everything fine while importing nothing.
 */
function interpret(statusCode, text) {
  if (statusCode !== 200) {
    return { ok: false, reachable: true, error: `Tally answered HTTP ${statusCode}`, raw: text };
  }

  const pick = (tag) => {
    const m = new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i').exec(text);
    return m ? m[1].trim() : null;
  };

  const lineError = /<LINEERROR>([\s\S]*?)<\/LINEERROR>/i.exec(text);
  if (lineError) {
    return { ok: false, reachable: true, error: lineError[1].trim().slice(0, 400), raw: text };
  }

  const errors = Number(pick('ERRORS') || 0);
  const exceptions = Number(pick('EXCEPTIONS') || 0);
  const created = Number(pick('CREATED') || 0);
  const altered = Number(pick('ALTERED') || 0);

  if (errors > 0 || exceptions > 0) {
    return {
      ok: false,
      reachable: true,
      error: `Tally reported ${errors} error(s) and ${exceptions} exception(s).`,
      raw: text,
    };
  }
  if (created + altered === 0) {
    // Accepted nothing and complained about nothing: almost always the wrong
    // SVCURRENTCOMPANY, which Tally answers by doing precisely nothing.
    return {
      ok: false,
      reachable: true,
      error: 'Tally created and altered nothing. Check TALLY_COMPANY matches the open company exactly.',
      raw: text,
    };
  }

  return {
    ok: true,
    reachable: true,
    created,
    altered,
    masterId: pick('LASTVCHID') || pick('MASTERID'),
    raw: text,
  };
}

/**
 * Read a list of names out of a Tally export.
 *
 * Used by the preflight to check that the ledgers vouchers will post against
 * actually exist in that company. Deliberately tiny — see the note on the
 * parser in tallySync.js for why there is no XML dependency here.
 */
function namesIn(text, element) {
  const out = [];
  const re = new RegExp(`<${element}[^>]*>[\\s\\S]*?<NAME>([^<]*)</NAME>`, 'gi');
  let m = re.exec(text || '');
  while (m) {
    out.push(m[1].replace(/&amp;/g, '&').trim());
    m = re.exec(text || '');
  }
  return out;
}

/**
 * The preflight — everything that can be checked before the first real push.
 *
 * This exists because the first run against the office machine is the one part
 * of section 14 that cannot be proved from here, and a first run that fails
 * opaquely costs an afternoon. Every check below answers a question somebody
 * would otherwise have to guess at, and each says what to DO about a failure
 * rather than merely that it failed.
 *
 * It writes nothing to Tally. The voucher check is a deliberate no-op import —
 * an envelope with no TALLYMESSAGE in it — which exercises the request path and
 * the company routing without creating anything.
 */
async function doctor() {
  const cfg = config();
  const checks = [];
  const add = (name, ok, detail, fix) => checks.push({ name, ok, detail, fix });

  add('TALLY_ENABLED is true', cfg.enabled,
    cfg.enabled ? 'on' : 'off',
    'Set TALLY_ENABLED=true in backend/.env once the rest of this passes.');

  add('TALLY_COMPANY is set', Boolean(cfg.company),
    cfg.company || '(unset)',
    'Copy the company name EXACTLY as Tally shows it at Gateway of Tally.');

  const reach = await post(exportEnvelope(cfg.company || 'x', 'List of Companies'));
  add('Tally answers on the gateway', reach.reachable,
    reach.reachable ? `${cfg.host}:${cfg.port}` : reach.error,
    'In Tally: F1 → Advanced Configuration → "Act as Server" = Yes, port 9000. '
    + 'Check a firewall is not blocking it.');

  if (!reach.reachable) return { ok: false, config: cfg, checks };

  // Does the company name match? Tally answers a wrong one by importing
  // nothing and saying nothing, so this is checked explicitly rather than
  // discovered as fifty silently-failed invoices.
  const companies = namesIn(reach.raw, 'COMPANY');
  const matches = !cfg.company || companies.length === 0
    || companies.some((c) => c === cfg.company);
  add('TALLY_COMPANY matches an open company', matches,
    companies.length ? `open: ${companies.join(', ')}` : 'Tally listed no companies',
    `Set TALLY_COMPANY to one of: ${companies.join(', ') || '(open a company in Tally)'}`);

  // The ledgers every voucher posts against. A missing one is the most common
  // first-run failure and Tally's message for it — "Ledger 'X' does not exist"
  // — is only seen after a document has already failed.
  const ledgerRes = await post(exportEnvelope(cfg.company, 'List of Ledgers'));
  const ledgers = namesIn(ledgerRes.raw, 'LEDGER');

  const needed = {
    TALLY_SALES_LEDGER: process.env.TALLY_SALES_LEDGER || 'Sales',
    TALLY_PURCHASE_LEDGER: process.env.TALLY_PURCHASE_LEDGER || 'Purchase',
    TALLY_GST_LEDGER: process.env.TALLY_GST_LEDGER || 'Output GST',
    TALLY_INPUT_GST_LEDGER: process.env.TALLY_INPUT_GST_LEDGER || 'Input GST',
    TALLY_CASH_LEDGER: process.env.TALLY_CASH_LEDGER || 'Cash',
    TALLY_BANK_LEDGER: process.env.TALLY_BANK_LEDGER || 'Bank',
  };

  if (!ledgers.length) {
    add('the posting ledgers exist', false,
      'Tally returned no ledgers — the company may be wrong or empty.',
      'Fix TALLY_COMPANY first, then re-run.');
  } else {
    for (const [envVar, name] of Object.entries(needed)) {
      const found = ledgers.some((l) => l.toLowerCase() === String(name).toLowerCase());
      add(`ledger "${name}" exists`, found,
        found ? 'found' : `not among ${ledgers.length} ledgers`,
        `Either create "${name}" in Tally, or set ${envVar} to the ledger this `
        + 'company actually uses.');
    }
  }

  // The request path itself, without creating anything.
  const noop = await post(importEnvelope(cfg.company, ''));
  add('an import request is accepted', noop.reachable && !/HTTP/.test(noop.error || ''),
    noop.ok ? 'accepted' : (noop.error || 'no error'),
    'If this fails but the gateway answered, the request shape is being rejected '
    + '— send the payload from GET /api/tally/queue/:id/payload with curl to see '
    + 'Tally\'s own words.');

  return {
    ok: checks.every((c) => c.ok),
    config: { host: `${cfg.host}:${cfg.port}`, company: cfg.company || null },
    checks,
    ledgers_found: ledgers.length,
  };
}

/** Is Tally there? Used by the health endpoint and before a drain. */
async function ping() {
  const cfg = config();
  if (!cfg.enabled) {
    return { enabled: false, reachable: false, note: 'TALLY_ENABLED is not true.' };
  }
  if (!cfg.company) {
    return { enabled: true, reachable: false, note: 'TALLY_COMPANY is not set.' };
  }
  const res = await post(exportEnvelope(cfg.company, 'List of Companies'));
  return {
    enabled: true,
    reachable: res.reachable,
    company: cfg.company,
    host: `${cfg.host}:${cfg.port}`,
    note: res.reachable ? 'Tally answered.' : res.error,
  };
}

/**
 * Exponential backoff, capped.
 *
 * Tally being closed overnight is the normal case, not an incident. Without
 * backoff the worker would attempt a push every few seconds for fourteen hours
 * and fill the log with the same connection refusal 10,000 times.
 */
function backoffMinutes(attempts) {
  return Math.min(2 ** Math.min(attempts, 6), 60);
}

/** A stable hash of a pulled record, so an unchanged master is not rewritten. */
const hashOf = (obj) => crypto.createHash('sha256')
  .update(JSON.stringify(obj)).digest('hex').slice(0, 64);

module.exports = {
  config,
  xml,
  tallyDate,
  importEnvelope,
  exportEnvelope,
  ledgerEntry,
  inventoryEntry,
  voucher,
  salesOrderXml,
  salesInvoiceXml,
  creditNoteXml,
  purchaseXml,
  stockJournalXml,
  receiptXml,
  ledgerMasterXml,
  itemMasterXml,
  enqueue,
  post,
  interpret,
  ping,
  doctor,
  namesIn,
  backoffMinutes,
  hashOf,
};
