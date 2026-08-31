/**
 * The Tally worker: drain the outbox, then pull the masters.
 *
 * Source: KL_App_Requirements_FINAL.pdf section 14.
 *
 * `utils/tally.js` knows how to talk to Tally and how to build a voucher. This
 * knows when, in what order, and what to do when Tally says no.
 *
 * Two halves, run in this order and for a reason:
 *
 *   push   documents we authored, oldest first. Order matters — a Sales Order
 *          must reach Tally before the invoice that references it, and a party
 *          ledger before either. Sorting by id gives that for free, because a
 *          document cannot be created before its dependencies existed.
 *
 *   pull   masters Tally authored, plus the derived figures we RECONCILE rather
 *          than apply. Second, so a party created in the app this morning is
 *          already in Tally before we ask Tally what parties it has — otherwise
 *          the pull would report it missing and somebody would create it twice.
 */

const {
  config, ping, post, enqueue,
  exportEnvelope, ledgerMasterXml, itemMasterXml,
  salesOrderXml, salesInvoiceXml, creditNoteXml, purchaseXml, stockJournalXml, receiptXml,
  backoffMinutes, hashOf,
} = require('./tally');
const { businessDay } = require('./businessDay');
const { money, qty, notify, usersWhoCan } = require('./workflow');

/** How many documents one drain will attempt. Bounded so a run always ends. */
const BATCH = Number(process.env.TALLY_BATCH || 50);

// ---------------------------------------------------------------------------
// Rebuilding a queued payload
// ---------------------------------------------------------------------------

/**
 * A queue row stores the XML built at enqueue time, which is what gets sent.
 *
 * This exists for the other case: a row enqueued before a column existed, or
 * one whose payload is empty because the enqueue happened in a transaction that
 * could not read a join it needed. Rebuilding from current state is a fallback,
 * and it is deliberately NOT the default — the document must reach Tally as it
 * was when the event happened, not as the database looks today.
 */
async function rebuild(conn, row, company) {
  const id = row.ref_id;
  switch (row.kind) {
    case 'sales_order': {
      const [[order]] = await conn.query(
        `SELECT o.*, c.name AS party_name FROM orders o
           JOIN customers c ON c.masterid = o.customer_id WHERE o.order_id = ?`, [id]);
      if (!order) return null;
      const [lines] = await conn.query(
        `SELECT oi.*, i.unit FROM order_items oi
           LEFT JOIN items i ON i.masterid = oi.item_id WHERE oi.order_id = ?`, [id]);
      return salesOrderXml({ order, lines, company });
    }
    case 'sales_invoice': {
      const [[invoice]] = await conn.query('SELECT * FROM invoices WHERE id = ?', [id]);
      if (!invoice) return null;
      const [lines] = await conn.query(
        `SELECT ii.*, i.unit FROM invoice_items ii
           LEFT JOIN items i ON i.masterid = ii.item_id WHERE ii.invoice_id = ?`, [id]);
      return salesInvoiceXml({ invoice, lines, company });
    }
    case 'credit_note':
    case 'cash_discount_note': {
      const [[note]] = await conn.query(
        `SELECT n.*, c.name AS party_name FROM credit_notes n
           JOIN customers c ON c.masterid = n.customer_id WHERE n.id = ?`, [id]);
      return note ? creditNoteXml({ note, company }) : null;
    }
    case 'purchase_voucher':
    case 'unregistered_purchase':
    case 'purchase_conversion': {
      const [[purchase]] = await conn.query('SELECT * FROM purchases WHERE id = ?', [id]);
      if (!purchase) return null;
      const [lines] = await conn.query(
        `SELECT pi.*, i.unit FROM purchase_items pi
           LEFT JOIN items i ON i.masterid = pi.item_id WHERE pi.purchase_id = ?`, [id]);
      return purchaseXml({
        purchase, lines, company, registered: purchase.doc_state !== 'unregistered' });
    }
    case 'stock_journal': {
      const [[transfer]] = await conn.query('SELECT * FROM internal_transfers WHERE id = ?', [id]);
      if (!transfer) return null;
      const [lines] = await conn.query(
        'SELECT * FROM internal_transfer_items WHERE transfer_id = ?', [id]);
      return stockJournalXml({ transfer, lines, company });
    }
    case 'receipt': {
      const [[payment]] = await conn.query(
        `SELECT p.*, c.name AS party_name FROM payments p
           JOIN customers c ON c.masterid = p.customer_id WHERE p.id = ?`, [id]);
      return payment ? receiptXml({ payment, company }) : null;
    }
    case 'ledger_master': {
      const [[customer]] = await conn.query(
        'SELECT * FROM customers WHERE masterid = ?', [id]);
      if (!customer) return null;
      // The name Tally currently knows this party by. Tally has no id for a
      // ledger — it is keyed on NAME — so an alter under a NEW name matches
      // nothing and Tally creates a second ledger, leaving the original
      // holding all the history. Looking the party up under its previous name
      // is what turns that into a rename.
      const [[link]] = await conn.query(
        "SELECT tally_name FROM tally_links WHERE entity = 'customer' AND local_id = ?",
        [String(id)]);
      return ledgerMasterXml({
        customer,
        company,
        previousName: link && link.tally_name && link.tally_name !== customer.name
          ? link.tally_name : null,
      });
    }
    case 'item_master': {
      const [[item]] = await conn.query('SELECT * FROM items WHERE masterid = ?', [id]);
      return item ? itemMasterXml({ item, company }) : null;
    }
    default:
      return null;
  }
}

/** Which of our tables a queue kind links back to, for `tally_links`. */
const LINK_ENTITY = {
  sales_order: 'order',
  sales_invoice: 'invoice',
  credit_note: 'credit_note',
  cash_discount_note: 'credit_note',
  purchase_voucher: 'purchase',
  unregistered_purchase: 'purchase',
  purchase_conversion: 'purchase',
  stock_journal: 'transfer',
  receipt: 'payment',
  ledger_master: 'customer',
  item_master: 'item',
};

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

/**
 * Send what is waiting.
 *
 * Each document is its own transaction. One rejected invoice must not roll back
 * the twelve that went before it — the whole point of a queue is that progress
 * is kept.
 */
async function push(pool) {
  const cfg = config();
  const started = await beginRun(pool, 'push', 'outbox');

  if (!cfg.enabled || !cfg.company) {
    await endRun(pool, started, {
      ok: 0, fail: 0, reachable: false,
      note: !cfg.enabled ? 'TALLY_ENABLED is not true.' : 'TALLY_COMPANY is not set.',
    });
    return { skipped: true, sent: 0, failed: 0 };
  }

  const [rows] = await pool.query(
    `SELECT * FROM tally_queue
      WHERE status IN ('pending','failed')
        AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
      ORDER BY id ASC LIMIT ?`, [BATCH]);

  if (!rows.length) {
    await endRun(pool, started, { ok: 0, fail: 0, reachable: true, note: 'Nothing waiting.' });
    return { sent: 0, failed: 0 };
  }

  // Asked once, not once per document: if Tally is closed there is no point
  // attempting fifty pushes to discover it fifty times, and every one of those
  // would burn an attempt and lengthen the backoff.
  const reach = await ping();
  if (!reach.reachable) {
    await pool.query(
      `UPDATE tally_queue
          SET status = 'failed', last_error = ?, attempts = attempts + 1,
              next_attempt_at = DATE_ADD(NOW(), INTERVAL ? MINUTE)
        WHERE id IN (?)`,
      [reach.note, backoffMinutes(rows[0].attempts + 1), rows.map((r) => r.id)]);
    await endRun(pool, started, {
      ok: 0, fail: rows.length, reachable: false, note: reach.note });
    return { sent: 0, failed: rows.length, reachable: false, note: reach.note };
  }

  let sent = 0;
  let failed = 0;

  for (const row of rows) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      // Claimed under a lock so two workers cannot send the same voucher twice.
      const [claim] = await conn.query(
        "UPDATE tally_queue SET status = 'sending' WHERE id = ? AND status IN ('pending','failed')",
        [row.id]);
      if (!claim.affectedRows) { await conn.rollback(); continue; }
      await conn.commit();

      const payload = row.payload && row.payload.trim()
        ? row.payload
        : await rebuild(conn, row, cfg.company);

      if (!payload) {
        await pool.query(
          `UPDATE tally_queue SET status = 'skipped',
                  last_error = 'The document no longer exists.' WHERE id = ?`,
          [row.id]);
        continue;
      }

      const res = await post(payload);

      if (res.ok) {
        await conn.beginTransaction();
        await conn.query(
          `UPDATE tally_queue SET status = 'sent', sent_at = NOW(), last_error = NULL,
                  attempts = attempts + 1, tally_master_id = ?
            WHERE id = ?`,
          [res.masterId || null, row.id]);

        const entity = LINK_ENTITY[row.kind];
        if (entity) {
          // The NAME is recorded alongside the id, and for a master it is the
          // load-bearing half: it is what Tally will be asked to look the
          // record up by next time, and comparing it to the current name is
          // the only way to notice a rename has happened here.
          const sentName = /<(?:LEDGER|STOCKITEM)[^>]*>[\s\S]*?<NAME>([^<]*)<\/NAME>/
            .exec(payload)?.[1] || null;

          await conn.query(
            `INSERT INTO tally_links (entity, local_id, tally_master_id, tally_name, synced_at)
             VALUES (?, ?, ?, ?, NOW())
             ON DUPLICATE KEY UPDATE
               tally_master_id = VALUES(tally_master_id),
               tally_name = COALESCE(VALUES(tally_name), tally_name),
               synced_at = NOW()`,
            [entity, String(row.ref_id), res.masterId || null,
              sentName ? sentName.replace(/&amp;/g, '&') : null]);
        }
        await conn.commit();
        sent += 1;
      } else {
        await pool.query(
          `UPDATE tally_queue
              SET status = 'failed', attempts = attempts + 1, last_error = ?,
                  next_attempt_at = DATE_ADD(NOW(), INTERVAL ? MINUTE)
            WHERE id = ?`,
          [String(res.error).slice(0, 500), backoffMinutes(row.attempts + 1), row.id]);
        failed += 1;

        // A document Tally has refused several times is a real problem, not a
        // closed application, and somebody has to look at it.
        if (row.attempts + 1 === 5) {
          const c2 = await pool.getConnection();
          try {
            for (const owner of await usersWhoCan(c2, 'all')) {
              await notify(c2, {
                userId: owner,
                tone: 'warning',
                title: 'Tally has rejected a document five times',
                body: `${row.kind} ${row.ref_type}#${row.ref_id}: ${String(res.error).slice(0, 200)}`,
                refType: 'tally_queue',
                refId: row.id,
              });
            }
          } finally { c2.release(); }
        }
      }
    } catch (err) {
      await conn.rollback().catch(() => {});
      await pool.query(
        `UPDATE tally_queue SET status = 'failed', attempts = attempts + 1, last_error = ?
          WHERE id = ?`, [String(err.message).slice(0, 500), row.id]);
      failed += 1;
    } finally {
      conn.release();
    }
  }

  await endRun(pool, started, { ok: sent, fail: failed, reachable: true });
  return { sent, failed, reachable: true };
}

// ---------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------

/**
 * Read a Tally export into rows.
 *
 * A deliberately small parser rather than an XML library: Tally's export is a
 * flat repetition of one element per record, and what is needed is the text of
 * a handful of known child tags. An XML dependency to read four fields would be
 * a dependency to audit, and Tally's output is not well-formed enough for a
 * strict parser to accept anyway — it emits raw `&` in party names.
 */
function extract(text, element, fields) {
  const out = [];
  const re = new RegExp(`<${element}[^>]*>([\\s\\S]*?)</${element}>`, 'gi');
  let m = re.exec(text);
  while (m) {
    const block = m[1];
    const rec = {};
    for (const f of fields) {
      const fm = new RegExp(`<${f}[^>]*>([\\s\\S]*?)</${f}>`, 'i').exec(block);
      rec[f.toLowerCase()] = fm
        ? fm[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim()
        : null;
    }
    out.push(rec);
    m = re.exec(text);
  }
  return out;
}

/**
 * Party master, Tally → App (section 14: "Party master (7,000+ parties)").
 *
 * Matched on name, because that is what Tally keys a ledger by. A party we
 * already have is UPDATED only in the fields Tally owns — address, GSTIN,
 * phone. It must never overwrite `customer_type`, `salesman_id` or
 * `closing_balance`: the first two are ours and Tally has no concept of them,
 * and the third is a cache of our own ledger.
 */
async function pullParties(pool) {
  const cfg = config();
  const started = await beginRun(pool, 'pull', 'parties');

  const res = await post(exportEnvelope(cfg.company, 'List of Ledgers'));
  if (!res.reachable) {
    await endRun(pool, started, { ok: 0, fail: 0, reachable: false, note: res.error });
    return { reachable: false, note: res.error };
  }

  const records = extract(res.raw || '', 'LEDGER',
    ['NAME', 'PARENT', 'PARTYGSTIN', 'LEDGERPHONE', 'ADDRESS', 'LEDSTATENAME', 'PINCODE']);

  const debtorGroup = (process.env.TALLY_DEBTOR_GROUP || 'Sundry Debtors').toLowerCase();
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const rec of records) {
    if (!rec.name) { skipped += 1; continue; }
    // Only customers. Tally's ledger list includes bank accounts, tax ledgers
    // and expense heads, and importing those as parties would be nonsense.
    if (!rec.parent || !String(rec.parent).toLowerCase().includes(debtorGroup.split(' ').pop())) {
      skipped += 1;
      continue;
    }

    const hash = hashOf(rec);
    const [[link]] = await pool.query(
      "SELECT * FROM tally_links WHERE entity = 'customer' AND tally_name = ?", [rec.name]);

    if (link && link.last_hash === hash) { skipped += 1; continue; }

    const [[existing]] = await pool.query(
      'SELECT masterid FROM customers WHERE name = ?', [rec.name]);

    if (existing) {
      await pool.query(
        `UPDATE customers
            SET gst_number = COALESCE(NULLIF(?, ''), gst_number),
                phone      = COALESCE(NULLIF(?, ''), phone),
                address    = COALESCE(NULLIF(?, ''), address),
                state      = COALESCE(NULLIF(?, ''), state),
                pincode    = COALESCE(NULLIF(?, ''), pincode)
          WHERE masterid = ?`,
        [rec.partygstin, rec.ledgerphone, rec.address, rec.ledstatename, rec.pincode,
          existing.masterid]);
      updated += 1;
      await linkUp(pool, 'customer', existing.masterid, rec.name, hash);
    } else {
      // customer_type is deliberately left NULL. Tally does not know which of
      // our six rate columns a party buys at, and POST /orders refuses an
      // unclassified party rather than guessing — which is the correct outcome
      // for 7,000 parties arriving with no classification.
      const [ins] = await pool.query(
        `INSERT INTO customers (name, gst_number, phone, address, state, pincode, group_name)
         VALUES (?, ?, ?, ?, ?, ?, 'Tally')`,
        [rec.name, rec.partygstin || null, rec.ledgerphone || null,
          rec.address || null, rec.ledstatename || null, rec.pincode || null]);
      created += 1;
      await linkUp(pool, 'customer', ins.insertId, rec.name, hash);
    }
  }

  await endRun(pool, started, {
    ok: created + updated, fail: 0, reachable: true,
    note: `${created} created, ${updated} updated, ${skipped} skipped of ${records.length}`,
  });
  return { created, updated, skipped, total: records.length, reachable: true };
}

/**
 * Item master, Tally → App (section 14: "Item master (7,300+ items)").
 *
 * Names, units, HSN and GST — nothing about price. The rate card comes from the
 * spreadsheets and `utils/pricing.js` derives from it; Tally holds no notion of
 * our six customer-type rates, so there is nothing there to import.
 *
 * This is also where the two data gaps get filled if Tally has them: HSN and
 * GST percent are blank on every imported item, and Tally may know both.
 */
async function pullItems(pool) {
  const cfg = config();
  const started = await beginRun(pool, 'pull', 'items');

  const res = await post(exportEnvelope(cfg.company, 'List of StockItems'));
  if (!res.reachable) {
    await endRun(pool, started, { ok: 0, fail: 0, reachable: false, note: res.error });
    return { reachable: false, note: res.error };
  }

  const records = extract(res.raw || '', 'STOCKITEM',
    ['NAME', 'PARENT', 'BASEUNITS', 'HSNCODE', 'GSTRATE', 'CLOSINGBALANCE', 'CLOSINGRATE']);

  let created = 0;
  let updated = 0;

  for (const rec of records) {
    if (!rec.name) continue;

    const [[existing]] = await pool.query(
      'SELECT masterid, hsn, gst_percent FROM items WHERE name = ?', [rec.name]);

    const gst = rec.gstrate ? Number(String(rec.gstrate).replace(/[^\d.]/g, '')) : null;

    if (existing) {
      // COALESCE(NULLIF(...)) so Tally fills a gap but never blanks something
      // we already know. The rate card is ours; these four fields are not.
      await pool.query(
        `UPDATE items
            SET hsn         = COALESCE(NULLIF(?, ''), hsn),
                unit        = COALESCE(NULLIF(?, ''), unit),
                gst_percent = CASE WHEN ? > 0 AND gst_percent = 0 THEN ? ELSE gst_percent END,
                brand       = COALESCE(brand, NULLIF(?, ''))
          WHERE masterid = ?`,
        [rec.hsncode, rec.baseunits, gst || 0, gst || 0, rec.parent, existing.masterid]);
      updated += 1;
      await linkUp(pool, 'item', existing.masterid, rec.name, hashOf(rec));
    } else {
      // pricing_type stays NULL: an item Tally knows about and the rate sheet
      // does not is not sellable, and rateFor() refuses it by design rather
      // than pricing it at zero.
      const [ins] = await pool.query(
        `INSERT INTO items (name, brand, unit, hsn, gst_percent)
         VALUES (?, ?, ?, ?, ?)`,
        [rec.name, rec.parent || null, rec.baseunits || null, rec.hsncode || null, gst || 0]);
      created += 1;
      await linkUp(pool, 'item', ins.insertId, rec.name, hashOf(rec));
    }
  }

  await endRun(pool, started, {
    ok: created + updated, fail: 0, reachable: true,
    note: `${created} created, ${updated} updated of ${records.length}`,
  });
  return { created, updated, total: records.length, reachable: true };
}

/**
 * Stock levels and party balances, Tally → App — as a RECONCILIATION.
 *
 * Section 14 asks for both to flow this way. They are NOT written into
 * `items.qty` or `customers.closing_balance`: those are caches of our own
 * ledgers, and one pull that overwrote them would mean no figure in the app
 * could be explained from its own movements again.
 *
 * What lands is a comparison. A variance is a finding — nearly always a
 * document one system has and the other does not — and that is a question for a
 * person, not something to paper over by adopting whichever number arrived last.
 */
async function pullReconciliation(pool) {
  const cfg = config();
  const started = await beginRun(pool, 'pull', 'reconciliation');
  const day = businessDay();

  const res = await post(exportEnvelope(cfg.company, 'Stock Summary'));
  if (!res.reachable) {
    await endRun(pool, started, { ok: 0, fail: 0, reachable: false, note: res.error });
    return { reachable: false, note: res.error };
  }

  const stock = extract(res.raw || '', 'STOCKITEM', ['NAME', 'CLOSINGBALANCE', 'CLOSINGRATE']);
  let compared = 0;
  let variances = 0;

  for (const rec of stock) {
    if (!rec.name) continue;
    const [[item]] = await pool.query(
      'SELECT masterid, name, qty FROM items WHERE name = ?', [rec.name]);
    if (!item) continue;

    const tallyQty = qty(Number(String(rec.closingbalance || '0').replace(/[^\d.-]/g, '')) || 0);
    const localQty = qty(item.qty);
    const variance = qty(tallyQty - localQty);

    await pool.query(
      `INSERT INTO tally_reconciliation
         (as_at, entity, local_id, label, tally_value, local_value, variance)
       VALUES (?, 'item_stock', ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         tally_value = VALUES(tally_value), local_value = VALUES(local_value),
         variance = VALUES(variance)`,
      [day, String(item.masterid), item.name, tallyQty, localQty, variance]);

    compared += 1;
    if (Math.abs(variance) > 0.0001) variances += 1;

    // Historical purchase rate, which section 14 also lists and which feeds the
    // rate-change alert of 5.4. This one IS ours to keep: a rate Tally holds
    // from before the app existed is a fact we did not have.
    const rate = money(Number(String(rec.closingrate || '0').replace(/[^\d.]/g, '')) || 0);
    if (rate > 0) {
      await pool.query(
        'UPDATE items SET tally_last_purchase_rate = ?, tally_last_purchase_on = ? WHERE masterid = ?',
        [rate, day, item.masterid]);
    }
  }

  await endRun(pool, started, {
    ok: compared, fail: variances, reachable: true,
    note: `${compared} items compared, ${variances} with a variance`,
  });

  if (variances > 0) {
    const conn = await pool.getConnection();
    try {
      for (const owner of await usersWhoCan(conn, 'all')) {
        await notify(conn, {
          userId: owner,
          tone: 'warning',
          title: `Tally stock disagrees on ${variances} item(s)`,
          body: 'Neither figure was overwritten. Open the Tally reconciliation to resolve.',
          refType: 'tally_reconciliation',
          refId: null,
        });
      }
    } finally { conn.release(); }
  }

  return { compared, variances, reachable: true };
}

// ---------------------------------------------------------------------------
// Run bookkeeping
// ---------------------------------------------------------------------------

async function beginRun(pool, direction, scope) {
  const [res] = await pool.query(
    'INSERT INTO tally_sync_runs (direction, scope) VALUES (?, ?)', [direction, scope]);
  return res.insertId;
}

async function endRun(pool, id, { ok, fail, reachable, note }) {
  await pool.query(
    `UPDATE tally_sync_runs
        SET finished_at = NOW(), ok_count = ?, fail_count = ?, reachable = ?, note = ?
      WHERE id = ?`,
    [ok, fail, reachable, note ? String(note).slice(0, 500) : null, id]);
}

async function linkUp(pool, entity, localId, tallyName, hash) {
  await pool.query(
    `INSERT INTO tally_links (entity, local_id, tally_name, last_hash, synced_at)
     VALUES (?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       tally_name = VALUES(tally_name), last_hash = VALUES(last_hash), synced_at = NOW()`,
    [entity, String(localId), tallyName, hash]);
}

/**
 * One full cycle. Push first, then pull — see the note at the top of the file.
 *
 * Never throws: this runs unattended on a timer, and an exception here would
 * take the API process down over an accounting package being closed.
 */
async function cycle(pool, { pullMasters = false } = {}) {
  const cfg = config();
  const out = { enabled: cfg.enabled, push: null, pull: null };

  if (!cfg.enabled) {
    out.note = 'TALLY_ENABLED is not true — nothing was attempted.';
    return out;
  }

  try {
    out.push = await push(pool);
  } catch (err) {
    out.push = { error: err.message };
    console.error('[TALLY] push failed:', err.message);
  }

  // The masters are 7,000 parties and 7,300 items; pulling them every minute
  // would be pointless traffic. The worker pulls on a longer cadence, and
  // `--pull` forces one.
  if (pullMasters) {
    try {
      out.pull = {
        parties: await pullParties(pool),
        items: await pullItems(pool),
        reconciliation: await pullReconciliation(pool),
      };
    } catch (err) {
      out.pull = { error: err.message };
      console.error('[TALLY] pull failed:', err.message);
    }
  }

  return out;
}

module.exports = {
  push,
  pullParties,
  pullItems,
  pullReconciliation,
  cycle,
  extract,
  rebuild,
  enqueue,
  BATCH,
};
