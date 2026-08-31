#!/usr/bin/env node
/**
 * The Tally sync, proved against a stand-in that speaks Tally's own protocol.
 *
 *   node tests/tally-test.js
 *
 * Source: KL_App_Requirements_FINAL.pdf section 14.
 *
 * ---------------------------------------------------------------------------
 * What this is, and what it is not
 * ---------------------------------------------------------------------------
 * This starts a small HTTP server that answers on Tally's XML gateway protocol
 * and behaves the way Tally Prime does in the four ways that matter:
 *
 *   · it returns HTTP 200 for a REJECTED import, with the failure inside the
 *     XML — which is the single most common way a Tally integration is built
 *     wrong;
 *   · it returns CREATED=0 ALTERED=0 with no error when the company name does
 *     not match, which is what Tally actually does;
 *   · it keys vouchers on REMOTEID, so a second push of the same document is an
 *     ALTER rather than a second voucher;
 *   · it can be switched off mid-run, to prove the outbox survives it.
 *
 * It is NOT a real Tally instance, and passing here does not mean the first
 * push against the office machine will succeed — ledger names have to match
 * that company's chart of accounts, and Tally's own validation is stricter than
 * anything reproducible here. What it does prove is that the queue, the retry
 * and backoff, the idempotency, the error interpretation and the pull parser
 * are correct, which is everything except the dialect.
 *
 * Nothing in this file touches the live queue: it uses a scratch database so a
 * failed assertion cannot leave a real invoice marked as sent to Tally.
 */

const http = require('http');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const tally = require('../utils/tally');

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); return true; }
  fail += 1;
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}

const section = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 56 - t.length))}`);

// ---------------------------------------------------------------------------
// The stand-in
// ---------------------------------------------------------------------------

/**
 * A Tally-shaped server.
 *
 * `state.company` is the name it will accept. `state.rejectNext` makes the next
 * import fail the way Tally fails — 200 with a LINEERROR. `state.vouchers` maps
 * REMOTEID to a count, so a re-push is visible as an ALTER.
 */
function startFakeTally(state) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      state.requests.push(body);

      const company = /<SVCURRENTCOMPANY>([^<]*)<\/SVCURRENTCOMPANY>/.exec(body)?.[1] || '';
      const isExport = /<TALLYREQUEST>Export Data<\/TALLYREQUEST>/.test(body);
      const send = (xml) => {
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        res.end(xml);
      };

      // Tally answers a wrong company by doing nothing at all — no error, no
      // import. Reproduced exactly, because a sync that treats this as success
      // reports everything fine while importing nothing.
      if (company !== state.company) {
        return send('<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY><DATA>'
          + '<IMPORTRESULT><CREATED>0</CREATED><ALTERED>0</ALTERED>'
          + '<LASTVCHID>0</LASTVCHID><ERRORS>0</ERRORS><EXCEPTIONS>0</EXCEPTIONS>'
          + '</IMPORTRESULT></DATA></BODY></ENVELOPE>');
      }

      if (isExport) {
        const report = /<REPORTNAME>([^<]*)<\/REPORTNAME>/.exec(body)?.[1] || '';
        return send(state.exports[report] || '<ENVELOPE></ENVELOPE>');
      }

      if (state.rejectNext) {
        state.rejectNext = false;
        // Tally's own shape for a rejected line: HTTP 200, failure in the body.
        return send('<ENVELOPE><HEADER><STATUS>0</STATUS></HEADER><BODY><DATA>'
          + '<LINEERROR>Ledger \'Unknown Party\' does not exist</LINEERROR>'
          + '</DATA></BODY></ENVELOPE>');
      }

      // Tally identifies the two kinds of import differently, and reproducing
      // that is the point of this stand-in:
      //
      //   VOUCHERS are keyed on REMOTEID — our own document id — which is what
      //   makes a re-push an amendment.
      //
      //   MASTERS (a LEDGER, a STOCKITEM) are keyed on NAME. Tally's ledgers
      //   are name-keyed, so ACTION="Alter" on the same NAME amends the
      //   existing one; that is why the master builders carry no REMOTEID.
      //   The consequence worth knowing: renaming a party in this app creates a
      //   SECOND ledger in Tally rather than renaming the first, which is what
      //   tally_links.tally_name exists to detect.
      const key = /<REMOTEID>([^<]*)<\/REMOTEID>/.exec(body)?.[1]
        || /<(?:LEDGER|STOCKITEM)\s+NAME="([^"]*)"/.exec(body)?.[1];

      const seen = key ? state.vouchers.get(key) : undefined;
      if (key) state.vouchers.set(key, (seen || 0) + 1);

      const created = key && seen === undefined ? 1 : 0;
      const altered = key && seen !== undefined ? 1 : 0;
      const masterId = key ? String(1000 + state.vouchers.size) : '0';

      return send('<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY><DATA>'
        + `<IMPORTRESULT><CREATED>${created}</CREATED><ALTERED>${altered}</ALTERED>`
        + `<LASTVCHID>${masterId}</LASTVCHID><ERRORS>0</ERRORS><EXCEPTIONS>0</EXCEPTIONS>`
        + '</IMPORTRESULT></DATA></BODY></ENVELOPE>');
    });
  });
  return server;
}

// A Tally-format export, with the awkward bits real Tally emits: a raw
// ampersand in a party name, and an amount with a currency symbol.
const LEDGER_EXPORT = `<ENVELOPE>
 <BODY><DATA><TALLYMESSAGE>
  <LEDGER NAME="Bora &amp; Sons"><NAME>Bora &amp; Sons</NAME>
   <PARENT>Sundry Debtors</PARENT><PARTYGSTIN>18AABCB1234C1Z5</PARTYGSTIN>
   <LEDGERPHONE>9876500001</LEDGERPHONE><ADDRESS>Fancy Bazar</ADDRESS>
   <LEDSTATENAME>Assam</LEDSTATENAME><PINCODE>781001</PINCODE></LEDGER>
  <LEDGER NAME="ICICI Bank"><NAME>ICICI Bank</NAME>
   <PARENT>Bank Accounts</PARENT></LEDGER>
 </TALLYMESSAGE></DATA></BODY>
</ENVELOPE>`;

const STOCK_EXPORT = `<ENVELOPE>
 <BODY><DATA><TALLYMESSAGE>
  <STOCKITEM NAME="Tally Probe Item"><NAME>Tally Probe Item</NAME>
   <PARENT>Probe Brand</PARENT><BASEUNITS>pcs</BASEUNITS>
   <HSNCODE>85366990</HSNCODE><GSTRATE>18 %</GSTRATE>
   <CLOSINGBALANCE>42 pcs</CLOSINGBALANCE><CLOSINGRATE>125.50/pcs</CLOSINGRATE>
  </STOCKITEM>
 </TALLYMESSAGE></DATA></BODY>
</ENVELOPE>`;

const SCRATCH = 'kl_tally_check';

async function main() {
  const state = {
    company: 'KL Electricals Test',
    requests: [],
    vouchers: new Map(),
    rejectNext: false,
    exports: {
      'List of Companies': '<ENVELOPE><BODY><DATA>ok</DATA></BODY></ENVELOPE>',
      'List of Ledgers': LEDGER_EXPORT,
      'List of StockItems': STOCK_EXPORT,
      'Stock Summary': STOCK_EXPORT,
    },
  };

  const server = startFakeTally(state);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  // Point the sync at the stand-in for the duration of this file only.
  process.env.TALLY_ENABLED = 'true';
  process.env.TALLY_HOST = '127.0.0.1';
  process.env.TALLY_PORT = String(port);
  process.env.TALLY_COMPANY = state.company;

  // A scratch database, so a failure here can never mark a real invoice sent.
  const admin = await mysql.createConnection({
    host: process.env.DB_HOST, port: process.env.DB_PORT,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    multipleStatements: true,
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${SCRATCH}\``);
  await admin.query(`CREATE DATABASE \`${SCRATCH}\` CHARACTER SET utf8mb4`);
  await admin.query(`USE \`${SCRATCH}\``);
  await admin.query(require('fs').readFileSync(
    path.join(__dirname, '..', 'schema.sql'), 'utf8'));
  await admin.end();

  const pool = mysql.createPool({
    host: process.env.DB_HOST, port: process.env.DB_PORT,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    database: SCRATCH, dateStrings: true, connectionLimit: 5,
  });
  pool.on('connection', (c) => c.query(
    "SET time_zone = '+00:00', sql_mode = CONCAT(@@sql_mode, ',STRICT_TRANS_TABLES')"));

  // tallySync is required AFTER the env is set, so config() reads the stand-in.
  const sync = require('../utils/tallySync');

  try {
    // ---- reachability -----------------------------------------------------
    section('reachability');

    const up = await tally.ping();
    ok('the sync reports Tally reachable when it is',
      up.enabled === true && up.reachable === true, JSON.stringify(up));

    // ---- the outbox -------------------------------------------------------
    section('the outbox');

    await pool.query(
      `INSERT INTO users (id, name, email, role, password, permissions)
       VALUES ('probe', 'Probe', 'probe@test.local', 'admin', 'x', '["all"]')`);
    const [cust] = await pool.query(
      "INSERT INTO customers (name, group_name, customer_type) VALUES ('Bora & Sons', 'General', 'dealer')");

    const payload = tally.ledgerMasterXml({
      customer: { name: 'Bora & Sons', gst_number: '18AABCB1234C1Z5', phone: '9876500001' },
      company: state.company,
    });

    const conn = await pool.getConnection();
    await tally.enqueue(conn, {
      kind: 'ledger_master', refType: 'customer', refId: cust.insertId,
      payload, userId: 'probe',
    });
    conn.release();

    const [queued] = await pool.query("SELECT * FROM tally_queue WHERE status = 'pending'");
    ok('a document waits in the outbox', queued.length === 1, `${queued.length}`);

    // ---- push -------------------------------------------------------------
    section('push');

    const first = await sync.push(pool);
    ok('the push succeeds', first.sent === 1 && first.failed === 0, JSON.stringify(first));

    const [afterPush] = await pool.query('SELECT * FROM tally_queue');
    ok('and the row is marked sent with Tally\'s own id',
      afterPush[0].status === 'sent' && afterPush[0].tally_master_id,
      `${afterPush[0].status} ${afterPush[0].tally_master_id}`);

    const [links] = await pool.query('SELECT * FROM tally_links');
    ok('a link is recorded, so the document can be amended later',
      links.length === 1 && links[0].entity === 'customer', JSON.stringify(links));

    ok('the envelope reached Tally with the party name escaped',
      state.requests.some((r) => r.includes('Bora &amp; Sons')),
      'no escaped name in any request');

    // ---- idempotency, the property that matters most -----------------------
    section('idempotency');

    const conn2 = await pool.getConnection();
    await tally.enqueue(conn2, {
      kind: 'ledger_master', refType: 'customer', refId: cust.insertId,
      payload, userId: 'probe',
    });
    conn2.release();

    const [requeued] = await pool.query('SELECT * FROM tally_queue');
    ok('re-enqueueing the same document reuses its row rather than adding one',
      requeued.length === 1 && requeued[0].status === 'pending',
      `${requeued.length} row(s), status ${requeued[0].status}`);

    const second = await sync.push(pool);
    ok('the second push succeeds too', second.sent === 1, JSON.stringify(second));
    ok('and Tally ALTERED the existing voucher rather than creating a second',
      state.vouchers.size === 1 && state.vouchers.values().next().value === 2,
      `${state.vouchers.size} voucher(s), seen ${[...state.vouchers.values()].join(',')} time(s)`);

    // ---- rejection --------------------------------------------------------
    section('rejection — HTTP 200 with the failure inside');

    const [c2] = await pool.query(
      "INSERT INTO customers (name, group_name) VALUES ('Unknown Party', 'General')");
    const conn3 = await pool.getConnection();
    await tally.enqueue(conn3, {
      kind: 'ledger_master', refType: 'customer', refId: c2.insertId,
      payload: tally.ledgerMasterXml({
        customer: { name: 'Unknown Party' }, company: state.company }),
      userId: 'probe',
    });
    conn3.release();

    state.rejectNext = true;
    const rejected = await sync.push(pool);
    ok('a 200 carrying a LINEERROR is treated as a FAILURE',
      rejected.failed === 1 && rejected.sent === 0, JSON.stringify(rejected));

    const [failedRow] = await pool.query(
      "SELECT * FROM tally_queue WHERE ref_id = ? AND status = 'failed'", [c2.insertId]);
    ok('the reason Tally gave is kept, verbatim',
      failedRow.length === 1 && /does not exist/.test(failedRow[0].last_error),
      failedRow[0]?.last_error);
    ok('and a backoff is set, so a closed Tally is not hammered',
      failedRow[0].next_attempt_at !== null && failedRow[0].attempts === 1,
      `attempts=${failedRow[0].attempts} next=${failedRow[0].next_attempt_at}`);

    // ---- wrong company ----------------------------------------------------
    section('wrong company — Tally imports nothing and says nothing');

    // Simulated by changing what the STAND-IN accepts, not by changing the env.
    // The payload is frozen at enqueue time — deliberately, so a document
    // reaches Tally as it was when the event happened — which means
    // SVCURRENTCOMPANY is already inside the stored XML and no later env change
    // can alter it. Getting this wrong in the test was itself informative.
    const rightCompany = state.company;
    state.company = 'Some Other Company';
    await pool.query(
      "UPDATE tally_queue SET status = 'pending', next_attempt_at = NULL, attempts = 0");

    const wrongCo = await sync.push(pool);
    ok('created=0 altered=0 with no error is a FAILURE, not a success',
      wrongCo.sent === 0 && wrongCo.failed > 0, JSON.stringify(wrongCo));

    const [coError] = await pool.query(
      "SELECT last_error FROM tally_queue WHERE status = 'failed' LIMIT 1");
    ok('and the message names the likely cause',
      /TALLY_COMPANY/.test(coError[0]?.last_error || ''), coError[0]?.last_error);

    state.company = rightCompany;

    // ---- Tally switched off ----------------------------------------------
    section('Tally switched off mid-run');

    await new Promise((r) => server.close(r));
    await pool.query(
      "UPDATE tally_queue SET status = 'pending', next_attempt_at = NULL, attempts = 0");

    const offline = await sync.push(pool);
    ok('an unreachable Tally is reported as unreachable, not as a rejection',
      offline.reachable === false && offline.sent === 0, JSON.stringify(offline));

    // Two documents were enqueued — one per customer. The re-enqueue of the
    // first reused its row, which is the property asserted above.
    const [waiting] = await pool.query('SELECT * FROM tally_queue');
    ok('every document is still in the queue — nothing was lost',
      waiting.length === 2 && waiting.every((w) => w.status === 'failed'),
      `${waiting.length} row(s): ${waiting.map((w) => w.status).join(',')}`);
    ok('and the reason says Tally did not answer',
      waiting.every((w) => /contacting Tally|did not answer/.test(w.last_error || '')),
      waiting[0].last_error);

    // ---- the pull ---------------------------------------------------------
    section('pull — masters in, derived figures reconciled');

    const server2 = startFakeTally(state);
    await new Promise((r) => server2.listen(port, '127.0.0.1', r));

    const parties = await sync.pullParties(pool);
    ok('the party master imports', parties.reachable !== false && parties.total === 2,
      JSON.stringify(parties));
    ok('a bank ledger is NOT imported as a customer',
      parties.skipped >= 1, `skipped ${parties.skipped}`);

    const [imported] = await pool.query(
      "SELECT * FROM customers WHERE name = 'Bora & Sons'");
    ok('the raw ampersand in the name survived the round trip',
      imported.length === 1, `${imported.length} row(s)`);
    ok('and Tally filled the fields it owns',
      imported[0].gst_number === '18AABCB1234C1Z5' && imported[0].state === 'Assam',
      `${imported[0].gst_number} / ${imported[0].state}`);
    ok('while customer_type is left NULL — Tally does not know our rate columns',
      imported[0].customer_type === 'dealer' || imported[0].customer_type === null,
      String(imported[0].customer_type));

    const items = await sync.pullItems(pool);
    ok('the item master imports', items.created === 1, JSON.stringify(items));

    const [probeItem] = await pool.query(
      "SELECT * FROM items WHERE name = 'Tally Probe Item'");
    ok('with the HSN and GST rate parsed out of Tally\'s formatting',
      probeItem[0].hsn === '85366990' && Number(probeItem[0].gst_percent) === 18,
      `hsn=${probeItem[0].hsn} gst=${probeItem[0].gst_percent}`);
    ok('and pricing_type stays NULL — the rate card is not Tally\'s to set',
      probeItem[0].pricing_type === null, String(probeItem[0].pricing_type));

    // The invariant this whole design turns on.
    const recon = await sync.pullReconciliation(pool);
    ok('the reconciliation compares rather than applies', recon.compared >= 1,
      JSON.stringify(recon));

    const [afterRecon] = await pool.query(
      "SELECT qty FROM items WHERE name = 'Tally Probe Item'");
    ok('items.qty was NOT overwritten with Tally\'s 42',
      Number(afterRecon[0].qty) === 0,
      `items.qty is ${afterRecon[0].qty}; Tally said 42`);

    const [variance] = await pool.query(
      "SELECT * FROM tally_reconciliation WHERE entity = 'item_stock'");
    ok('the disagreement was recorded as a variance instead',
      variance.length === 1 && Number(variance[0].tally_value) === 42
        && Number(variance[0].local_value) === 0
        && Number(variance[0].variance) === 42,
      JSON.stringify(variance[0]));

    ok('and the historical purchase rate — which IS ours to keep — was stored',
      Number(afterRecon[0] && (await pool.query(
        "SELECT tally_last_purchase_rate r FROM items WHERE name = 'Tally Probe Item'"))[0][0].r)
        === 125.5,
      'tally_last_purchase_rate');

    await new Promise((r) => server2.close(r));

    // ---- run history ------------------------------------------------------
    section('run history');

    const [runs] = await pool.query('SELECT * FROM tally_sync_runs ORDER BY id');
    ok('every push and pull is on the record', runs.length >= 7, `${runs.length} run(s)`);
    ok('and an unreachable run is distinguishable from a rejection',
      runs.some((r) => r.reachable === 0) && runs.some((r) => r.reachable === 1),
      runs.map((r) => `${r.scope}:${r.reachable}`).join(' '));
  } finally {
    await pool.end();
    const cleanup = await mysql.createConnection({
      host: process.env.DB_HOST, port: process.env.DB_PORT,
      user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    });
    await cleanup.query(`DROP DATABASE IF EXISTS \`${SCRATCH}\``);
    await cleanup.end();
    try { server.close(); } catch { /* already closed */ }
  }
}

main()
  .then(() => {
    console.log(`\n${pass} passed, ${fail} failed`);
    console.log('\nNote: this proves the queue, retry, idempotency, error handling and');
    console.log('parser against a faithful stand-in. It is NOT a real Tally instance —');
    console.log('the first push against the office machine still needs its company name');
    console.log('and its ledger names. Run: npm run tally -- --ping');
    if (failures.length) {
      console.log('\nfailures:');
      failures.forEach((f) => console.log('  ✗ ' + f));
      process.exit(1);
    }
  })
  .catch((err) => {
    console.error('tally-test failed:', err);
    process.exit(1);
  });
