/**
 * The time-based half of section 13.
 *
 * Most notifications in the requirements fire because somebody did something —
 * an order was raised, a delivery failed — and those live in the route that
 * did it. The ones here fire because somebody DIDN'T: the EOD that was not
 * submitted by 7:15, the van that had not left by 10:30, the GST bill that has
 * not arrived in seven days. Nothing triggers them, so something has to look.
 *
 * `alert_log` is what stops them repeating. The sweep runs hourly and a
 * restart re-runs it; each rule inserts one row per (kind, subject, day) and a
 * duplicate key means it has already fired. That is one table instead of a
 * dozen `*_alerted_at` columns, and it cannot be forgotten on the next rule
 * added.
 *
 * Every rule is written to be safe to run at any hour. A rule with a deadline
 * checks the wall clock in BUSINESS_TIMEZONE itself rather than relying on
 * being called at the right time.
 */

const { businessDay, businessTime, minutesBetween } = require('./businessDay');
const { notify, usersWhoCan, usersHoldingExactly } = require('./workflow');
const { releaseDue: releaseGrowthDue } = require('./growthScheme');

/**
 * Fire once, ever, for this subject on this day.
 * Returns false if it has already fired — the caller then does nothing.
 */
async function claim(conn, { kind, refType = '', refId = '', day, detail = null }) {
  try {
    await conn.query(
      'INSERT INTO alert_log (kind, ref_type, ref_id, on_date, detail) VALUES (?, ?, ?, ?, ?)',
      [kind, refType, String(refId), day, detail],
    );
    return true;
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return false;
    throw err;
  }
}

/**
 * Send one notification to everyone who can act on it.
 *
 * `usersWhoCan`, not `usersWithGrant`: an area grant covers the actions beneath
 * it, so asking for 'attendance.view' the narrow way reached only the wildcard
 * holders and missed Manas, who holds `attendance` and is the person the late
 * check-in alert is for.
 */
async function tell(conn, grant, message) {
  const ids = await usersWhoCan(conn, grant);
  for (const userId of ids) await notify(conn, { userId, ...message });
  return ids.length;
}

/** True once the business-timezone clock has passed 'HH:MM'. */
const past = (hhmm, now) => minutesBetween(`${hhmm}:00`, businessTime(now)) >= 0;

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/**
 * R-20 — "EOD is mandatory by 7:15 p.m. If EOD is not submitted by 7:15 p.m.,
 * Yash receives an automatic notification."
 *
 * Fires on the ABSENCE of an eod_closings row, which is why it lives in the
 * sweep rather than in a route: nothing happens when somebody does not close
 * the day, so something has to look.
 */
async function eodNotSubmitted(conn, day, now) {
  if (!past('19:15', now)) return 0;
  const [[row]] = await conn.query('SELECT id FROM eod_closings WHERE close_date = ?', [day]);
  if (row) return 0;
  if (!await claim(conn, { kind: 'eod_missing', day })) return 0;
  return tell(conn, 'all', {
    tone: 'warning',
    title: 'End of Day not submitted',
    body: `Nothing has been closed for ${day}. It was due at 7:15 p.m.`,
    refType: 'eod', refId: null,
  });
}

/** "If drivers have not departed by 10:30 a.m., Yash receives a notification." */
async function departureNotLogged(conn, day, now) {
  if (!past('10:30', now)) return 0;
  const [sheets] = await conn.query(
    `SELECT s.id, s.zone, u.name AS driver FROM dispatch_sheets s
       LEFT JOIN users u ON u.id = s.driver_id
      WHERE s.sheet_date = ? AND s.departure_time IS NULL AND s.status <> 'cancelled'`,
    [day]);
  let sent = 0;
  for (const s of sheets) {
    if (!await claim(conn, { kind: 'departure_late', refType: 'dispatch_sheet', refId: s.id, day })) continue;
    sent += await tell(conn, 'all', {
      tone: 'warning',
      title: 'Van has not departed',
      body: `${s.driver || 'Driver'} — ${s.zone || 'route'} was due out at 10:30 a.m.`,
      refType: 'dispatch_sheet', refId: s.id,
    });
  }
  return sent;
}

/** "On the due date, Sibu receives a 9 a.m. reminder notification." */
async function chequesDueToday(conn, day, now) {
  if (!past('09:00', now)) return 0;
  const [cheques] = await conn.query(
    `SELECT q.id, q.cheque_no, q.amount, c.name AS party
       FROM cheques q JOIN customers c ON c.masterid = q.customer_id
      WHERE q.cheque_date = ? AND q.status = 'received'`, [day]);
  let sent = 0;
  for (const q of cheques) {
    if (!await claim(conn, { kind: 'cheque_due', refType: 'cheque', refId: q.id, day })) continue;
    sent += await tell(conn, 'cash', {
      tone: 'info',
      title: 'Cheque due today',
      body: `${q.party} — ${q.cheque_no} for ${Number(q.amount).toFixed(2)}. Deposit today.`,
      refType: 'cheque', refId: q.id,
    });
  }
  return sent;
}

/**
 * "2 days overdue: Sibu receives a reminder to call the transporter.
 *  5+ days overdue: Yash receives an escalation notification." (5.2)
 *
 * The two stamps on git_entries carry the state rather than alert_log, because
 * they are part of the consignment's own record — the register shows that the
 * transporter was chased and when.
 */
async function gitOverdue(conn, day) {
  const [rows] = await conn.query(
    `SELECT id, lr_number, supplier_name, transporter_name, expected_date,
            DATEDIFF(?, expected_date) AS overdue
       FROM git_entries
      WHERE status IN ('pending','arrived') AND expected_date IS NOT NULL
        AND DATEDIFF(?, expected_date) >= 2`,
    [day, day]);

  let sent = 0;
  for (const g of rows) {
    const overdue = Number(g.overdue);
    if (overdue >= 5) {
      const [[e]] = await conn.query('SELECT escalated_at FROM git_entries WHERE id = ?', [g.id]);
      if (!e.escalated_at) {
        await conn.query('UPDATE git_entries SET escalated_at = NOW() WHERE id = ?', [g.id]);
        sent += await tell(conn, 'all', {
          tone: 'warning',
          title: `Consignment ${overdue} days overdue`,
          body: `LR ${g.lr_number} from ${g.supplier_name} via ${g.transporter_name || 'transport'} — expected ${g.expected_date}.`,
          refType: 'git', refId: g.id,
        });
      }
    } else {
      const [[e]] = await conn.query('SELECT reminded_at FROM git_entries WHERE id = ?', [g.id]);
      if (!e.reminded_at) {
        await conn.query('UPDATE git_entries SET reminded_at = NOW() WHERE id = ?', [g.id]);
        sent += await tell(conn, 'purchases', {
          tone: 'info',
          title: 'Call the transporter',
          body: `LR ${g.lr_number} is ${overdue} days past its expected arrival.`,
          refType: 'git', refId: g.id,
        });
      }
    }
  }
  return sent;
}

/** "If the GST bill has not been received within 7 days, both Yash and Sibu are alerted." */
async function gstBillOverdue(conn, day) {
  const [rows] = await conn.query(
    `SELECT id, supplier_name, challan_no, gst_due_on FROM purchases
      WHERE doc_state = 'unregistered' AND gst_due_on IS NOT NULL
        AND gst_due_on < ? AND gst_alerted_at IS NULL`, [day]);
  let sent = 0;
  for (const p of rows) {
    await conn.query('UPDATE purchases SET gst_alerted_at = NOW() WHERE id = ?', [p.id]);
    const body = `${p.supplier_name} — challan ${p.challan_no || '(none)'} was due a GST bill by ${p.gst_due_on}.`;
    sent += await tell(conn, 'all', { tone: 'warning', title: 'GST bill overdue', body, refType: 'purchase', refId: p.id });
    sent += await tell(conn, 'purchases', { tone: 'warning', title: 'GST bill overdue', body, refType: 'purchase', refId: p.id });
  }
  return sent;
}

/** "If the credit note is not issued within 2 hours, Yash receives an alert." (R-10) */
async function creditNoteOverdue(conn) {
  const [rows] = await conn.query(
    `SELECT r.id, r.total_amount, c.name AS party
       FROM sales_returns r JOIN customers c ON c.masterid = r.customer_id
      WHERE r.cn_due_at IS NOT NULL AND r.cn_due_at < NOW() AND r.cn_alerted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM credit_notes n
                         WHERE n.return_id = r.id AND n.status = 'issued')`);
  let sent = 0;
  for (const r of rows) {
    await conn.query('UPDATE sales_returns SET cn_alerted_at = NOW() WHERE id = ?', [r.id]);
    sent += await tell(conn, 'all', {
      tone: 'warning',
      title: 'Credit note past its 2-hour SLA',
      body: `${r.party} — return for ${Number(r.total_amount).toFixed(2)} is still without a credit note.`,
      refType: 'sales_return', refId: r.id,
    });
  }
  return sent;
}

/** "Order pending 3+ days → Yash (escalation)." */
async function ordersStuck(conn, day) {
  const [rows] = await conn.query(
    `SELECT o.order_id, o.so_number, o.status, c.name AS party
       FROM orders o JOIN customers c ON c.masterid = o.customer_id
      WHERE o.is_no_order = FALSE
        AND o.status IN ('pending','confirmed')
        AND o.created_at < (NOW() - INTERVAL 3 DAY)`);
  let sent = 0;
  for (const o of rows) {
    if (!await claim(conn, { kind: 'order_stuck', refType: 'order', refId: o.order_id, day })) continue;
    sent += await tell(conn, 'all', {
      tone: 'warning',
      title: `Order waiting 3+ days`,
      body: `${o.so_number || `#${o.order_id}`} for ${o.party} is still ${o.status}.`,
      refType: 'order', refId: o.order_id,
    });
  }
  return sent;
}

/** "Item below minimum stock level → Yash." */
async function stockBelowMinimum(conn, day) {
  const [rows] = await conn.query(
    `SELECT masterid, name, qty, min_stock FROM items
      WHERE is_active = TRUE AND min_stock > 0 AND qty < min_stock
      ORDER BY (min_stock - qty) DESC LIMIT 25`);
  if (!rows.length) return 0;
  // One digest a day, not one notification per item: 8,900 items with a
  // minimum would otherwise bury every other alert on the list.
  if (!await claim(conn, { kind: 'stock_low', day, detail: `${rows.length} items` })) return 0;
  return tell(conn, 'all', {
    tone: 'warning',
    title: `${rows.length} item(s) below minimum stock`,
    body: rows.slice(0, 5).map((r) => `${r.name} (${Number(r.qty)}/${Number(r.min_stock)})`).join('; ')
      + (rows.length > 5 ? ` and ${rows.length - 5} more.` : ''),
    refType: 'stock', refId: null,
  });
}

/**
 * "At the end of the day, any dealer not visited must have a reason recorded.
 *  Manas is notified of unvisited dealers."
 */
async function beatNotVisited(conn, day, now) {
  if (!past('19:00', now)) return 0;
  const [rows] = await conn.query(
    `SELECT p.employee_id, u.name, COUNT(*) AS missed
       FROM beat_plans p
       JOIN beat_stops s ON s.plan_id = p.id
       JOIN users u ON u.id = p.employee_id
      WHERE p.plan_date = ? AND s.state = 'pending' AND s.skip_reason IS NULL
      GROUP BY p.employee_id, u.name`, [day]);
  let sent = 0;
  for (const r of rows) {
    if (!await claim(conn, { kind: 'beat_missed', refType: 'user', refId: r.employee_id, day })) continue;
    sent += await tell(conn, 'attendance.view', {
      tone: 'warning',
      title: 'Dealers not visited',
      body: `${r.name} left ${r.missed} stop(s) unvisited with no reason recorded.`,
      refType: 'beat_plan', refId: null,
    });
    await notify(conn, {
      userId: r.employee_id, tone: 'warning',
      title: 'Record why you missed those stops',
      body: `${r.missed} dealer(s) on today's beat have no visit and no reason.`,
      refType: 'beat_plan', refId: null,
    });
    sent += 1;
  }
  return sent;
}

/**
 * "If a salesman's GPS signal is lost for more than 15 minutes during working
 * hours, Manas receives a notification." (D.1)
 *
 * Only for staff on an open shift — a salesman who has checked out is not
 * missing, and one who never checked in is an attendance matter, not a
 * tracking one.
 */
async function gpsSilent(conn, day) {
  const [rows] = await conn.query(
    `SELECT c.employee_id, u.name,
            TIMESTAMPDIFF(MINUTE, COALESCE(MAX(l.recorded_at), c.checkin_time), NOW()) AS quiet
       FROM checkins c
       JOIN users u ON u.id = c.employee_id
       LEFT JOIN location_logs l ON l.user_id = c.employee_id AND l.recorded_at >= c.checkin_time
      WHERE c.checkin_date = ? AND c.checkout_time IS NULL AND u.geofenced = FALSE
      GROUP BY c.employee_id, u.name, c.checkin_time
     HAVING quiet > 15`, [day]);
  let sent = 0;
  for (const r of rows) {
    // Hourly rather than once a day: a signal that comes back and goes again
    // is worth saying twice, but not every sweep.
    const slot = `${day}#${new Date().getUTCHours()}`;
    if (!await claim(conn, { kind: 'gps_silent', refType: 'user', refId: `${r.employee_id}@${slot}`, day })) continue;
    sent += await tell(conn, 'live_tracking.view', {
      tone: 'warning',
      title: 'GPS signal lost',
      body: `${r.name} has not reported a position for ${r.quiet} minutes.`,
      refType: 'user', refId: null,
    });
  }
  return sent;
}

/**
 * Release the dealer growth-scheme awards whose window has closed.
 *
 * Source: LEMAC_Developer_Master_v7.xlsx — "Released only after full payment of
 * the goods."
 *
 * Two conditions, and the sweep is where they are checked because neither is
 * caused by a request: the window has to be over (one more invoice on the last
 * day could lift a dealer a rung, so the slab is not final until it closes),
 * and the invoices behind the accrual have to be settled.
 *
 * A window that closed with no slab reached is marked lapsed rather than left
 * accruing for ever, or the standings screen fills with dealers who bought once
 * in March.
 */
async function growthAwardsDue(conn, day) {
  const { released, lapsed } = await releaseGrowthDue(conn, day);
  if (!released.length) return 0;

  let sent = 0;
  for (const award of released) {
    if (!await claim(conn, {
      kind: 'growth_released', refType: 'growth_award', refId: award.id, day })) continue;

    sent += await tell(conn, 'schemes', {
      tone: 'success',
      title: `${award.party} earned a ${award.scheme} reward`,
      body: award.kind === 'growth_gift'
        ? `${award.window}: gift due. Issue it from the Schemes screen.`
        : `${award.window}: ${award.reward.toFixed(2)} credit due. Issue it from the Schemes screen.`,
      refType: 'growth_award', refId: award.id,
    });
  }
  if (lapsed.length) {
    console.log(`[ALERTS] ${lapsed.length} growth award(s) lapsed with no slab reached.`);
  }
  return sent;
}

/**
 * R-14 — "Gaurav must create the Tally Stock Journal entry on the same day a
 * transfer is received. If not done, Yash is notified the next day."
 *
 * "The next day" is why this checks the receipt DATE rather than an elapsed
 * number of hours: a transfer received at 6 p.m. and journalled at 9 the next
 * morning missed the same-day rule, and one received at 9 a.m. and journalled
 * at 5 p.m. did not.
 */
async function transferJournalOverdue(conn, day) {
  const [rows] = await conn.query(
    `SELECT id, transfer_no, from_godown, to_godown, received_at
       FROM internal_transfers
      WHERE status = 'received' AND journal_done_at IS NULL
        AND journal_alerted_at IS NULL
        AND DATE(received_at) < ?`, [day]);
  let sent = 0;
  for (const t of rows) {
    await conn.query(
      'UPDATE internal_transfers SET journal_alerted_at = NOW() WHERE id = ?', [t.id]);
    sent += await tell(conn, 'all', {
      tone: 'warning',
      title: `Stock journal not made — ${t.transfer_no}`,
      body: `${t.from_godown} → ${t.to_godown}, received ${String(t.received_at).slice(0, 10)}. `
        + 'R-14 requires the Tally entry the same day.',
      refType: 'transfer', refId: t.id,
    });
  }
  return sent;
}

/**
 * "On the follow-up due date, the creator receives a notification." (section 7)
 *
 * Sent to the creator, because "The creator of the estimate is responsible for
 * follow-up" — not to a manager who cannot make the call.
 */
async function estimateFollowUpDue(conn, day) {
  const [rows] = await conn.query(
    `SELECT e.id, e.created_by, e.total_amount, e.attempts, c.name AS party
       FROM estimates e JOIN customers c ON c.masterid = e.customer_id
      WHERE e.status IN ('draft','sent') AND e.follow_up_on = ? AND e.created_by IS NOT NULL`,
    [day]);
  let sent = 0;
  for (const e of rows) {
    if (!await claim(conn, { kind: 'estimate_follow_up', refType: 'estimate', refId: e.id, day })) continue;
    await notify(conn, {
      userId: e.created_by,
      tone: 'info',
      title: 'Follow up on your quote',
      body: `${e.party} — ${Number(e.total_amount).toFixed(2)}, attempt ${Number(e.attempts) + 1} of 3.`,
      refType: 'estimate', refId: e.id,
    });
    sent += 1;
  }
  return sent;
}

/**
 * "Every day, the application randomly assigns 5 items to designated staff
 * members (Ajit and Hirak) for a physical count... Staff are not informed in
 * advance which items will be selected. This is intentional." (section 10)
 *
 * The assignment is made by the server, once a day, from the items that
 * actually hold stock — counting 8,900 rows would mostly assign items nobody
 * has ever stocked.
 */
async function assignStockCount(conn, day) {
  // usersHoldingExactly, not usersWithGrant: the wildcard "all" satisfies
  // every grant, so asking the usual way handed Yash and Manoj a counting
  // task each. The document names the counters — Ajit and Hirak — and what
  // identifies them is holding the duty, not being able to grant it.
  const counters = await usersHoldingExactly(conn, 'stock_count.post');
  if (!counters.length) return 0;

  let made = 0;
  for (const userId of counters) {
    const [[existing]] = await conn.query(
      'SELECT id FROM stock_counts WHERE count_date = ? AND assigned_to = ?', [day, userId]);
    if (existing) continue;
    if (!await claim(conn, { kind: 'stock_count_assigned', refType: 'user', refId: userId, day })) continue;

    const [items] = await conn.query(
      `SELECT masterid, name, rack FROM items
        WHERE is_active = TRUE AND (qty <> 0 OR min_stock > 0)
        ORDER BY RAND() LIMIT 5`);
    if (!items.length) continue;

    const [c] = await conn.query(
      `INSERT INTO stock_counts (godown, count_date, assigned_to, is_auto, status, started_by)
       VALUES (NULL, ?, ?, TRUE, 'open', ?)`, [day, userId, userId]);

    for (const i of items) {
      await conn.query(
        `INSERT INTO stock_count_lines (count_id, item_id, item_name, rack, system_qty)
         VALUES (?, ?, ?, ?, (SELECT qty FROM items WHERE masterid = ?))`,
        [c.insertId, i.masterid, i.name, i.rack, i.masterid]);
    }

    await notify(conn, {
      userId, tone: 'info',
      title: "Today's stock count",
      body: `${items.length} items to count. They are chosen at random each day.`,
      refType: 'stock_count', refId: c.insertId,
    });
    made += 1;
  }
  return made;
}

// ---------------------------------------------------------------------------

const RULES = [
  ['eod_missing', (c, d, n) => eodNotSubmitted(c, d, n)],
  ['departure_late', (c, d, n) => departureNotLogged(c, d, n)],
  ['cheque_due', (c, d, n) => chequesDueToday(c, d, n)],
  ['git_overdue', (c, d) => gitOverdue(c, d)],
  ['gst_overdue', (c, d) => gstBillOverdue(c, d)],
  ['credit_note_sla', (c) => creditNoteOverdue(c)],
  ['order_stuck', (c, d) => ordersStuck(c, d)],
  ['stock_low', (c, d) => stockBelowMinimum(c, d)],
  ['beat_missed', (c, d, n) => beatNotVisited(c, d, n)],
  ['gps_silent', (c, d) => gpsSilent(c, d)],
  ['growth_released', (c, d) => growthAwardsDue(c, d)],
  ['transfer_journal', (c, d) => transferJournalOverdue(c, d)],
  ['estimate_follow_up', (c, d) => estimateFollowUpDue(c, d)],
  ['stock_count', (c, d) => assignStockCount(c, d)],
];

/**
 * Run every rule.
 *
 * Each rule gets its own transaction. One failing rule — a table missing after
 * a partial migration, say — must not roll back the alerts the others already
 * raised, and must not stop the sweep: the whole point is that these fire
 * unattended.
 */
async function runAlerts(pool, { now = new Date(), verbose = false } = {}) {
  const day = businessDay(now);
  const results = [];

  for (const [name, rule] of RULES) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const sent = await rule(conn, day, now);
      await conn.commit();
      if (sent) results.push({ rule: name, sent });
      if (verbose) console.log(`  ${name.padEnd(18)} ${sent || 0}`);
    } catch (err) {
      await conn.rollback().catch(() => {});
      console.error(`[ALERTS] ${name} failed: ${err.message}`);
      results.push({ rule: name, error: err.message });
    } finally {
      conn.release();
    }
  }

  return { day, results };
}

module.exports = { runAlerts, RULES, claim };
