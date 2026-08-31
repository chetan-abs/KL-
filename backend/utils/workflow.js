/**
 * Shared mechanics for the order pipeline.
 *
 * Every stage route needs the same four things: round money the way the schema
 * stores it, move an order from one stage to the next without losing how it got
 * there, keep items.qty in step with the ledger, and tell somebody. Written once
 * here so fourteen route modules cannot drift on any of them.
 *
 * Everything takes an explicit `conn` rather than reaching for the pool. These
 * are called inside transactions, and a helper that quietly opened its own
 * connection would commit outside the caller's — writing the movement but not
 * the order it belongs to when the caller later rolls back.
 */

/**
 * Money is stored to DECIMAL(15,2), so every intermediate is rounded to paise
 * before it is added up. Summing unrounded floats and rounding once at the end
 * drifts from the sum of the line totals the customer is shown.
 */
const money = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** Quantities are DECIMAL(15,4). Same argument, four places. */
const qty = (n) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;

/**
 * The pipeline, as a map of stage to the stages it may move to.
 *
 * Held here rather than as a check in each route so the shape of the workflow is
 * readable in one place, and so an illegal jump — picking straight to delivered,
 * skipping the count that R02 makes mandatory — is refused by default rather
 * than by remembering to guard it.
 *
 * 'confirmed' is treated exactly like 'pending'. POST /orders sets it when the
 * creator holds the `orders.confirm` grant — which every admin does — so an
 * order raised by an admin arrives already confirmed. Leaving that terminal
 * stranded those orders outside the pipeline entirely: they could never be
 * picked, billed or delivered, and nothing said why. Approval still has to
 * happen (R01); this only accepts both spellings of "not yet approved".
 *
 * 'completed' is genuinely terminal — it is the old web panel's end state and
 * nothing in the phone app produces or consumes it.
 */
const TRANSITIONS = {
  pending: ['approved', 'rejected', 'cancelled'],
  confirmed: ['approved', 'rejected', 'cancelled'],
  approved: ['picking', 'cancelled'],
  picking: ['picked', 'cancelled'],
  picked: ['verified', 'picking', 'cancelled'],
  verified: ['invoiced', 'picked', 'cancelled'],
  invoiced: ['dispatched', 'cancelled'],
  dispatched: ['delivered', 'undelivered'],
  // A failed delivery goes back on a sheet rather than ending the order.
  undelivered: ['dispatched', 'cancelled'],
  delivered: [],
  rejected: [],
  cancelled: ['pending'],
};

function canTransition(from, to) {
  return Boolean(TRANSITIONS[from]?.includes(to));
}

/**
 * Moves an order to a new stage and records that it happened.
 *
 * The status column is the current position; `order_events` is why it can be
 * trusted. Both are written here, in the caller's transaction, so an order can
 * never be found in a stage no event explains.
 *
 * Returns `{ ok: false, reason }` rather than throwing on an illegal move: the
 * caller turns it into a 409 with a message naming both stages, which is more
 * use to the client than a 500.
 */
async function transition(conn, { orderId, to, note = null, userId = null, expectedFrom = null }) {
  const [[order]] = await conn.query(
    'SELECT order_id, status FROM orders WHERE order_id = ? FOR UPDATE',
    [orderId]
  );

  if (!order) return { ok: false, reason: 'NOT_FOUND', message: 'No such order' };

  const from = order.status;

  // Lets a route insist on the stage it believed it was acting on, so two
  // people approving the same order do not both succeed. Takes a list as well
  // as a single stage, because "not yet approved" is spelled two ways —
  // 'pending' and 'confirmed' — and a route should not have to care which.
  const allowed = expectedFrom === null ? null : [].concat(expectedFrom);
  if (allowed && !allowed.includes(from)) {
    return {
      ok: false,
      reason: 'STALE',
      message: `Order is ${from}, not ${allowed.join(' or ')} — somebody else moved it.`,
    };
  }

  if (from === to) return { ok: true, from, to, unchanged: true };

  if (!canTransition(from, to)) {
    return {
      ok: false,
      reason: 'ILLEGAL',
      message: `An order cannot go from ${from} to ${to}.`,
    };
  }

  await conn.query('UPDATE orders SET status = ? WHERE order_id = ?', [to, orderId]);
  await conn.query(
    `INSERT INTO order_events (order_id, from_status, to_status, note, created_by)
     VALUES (?, ?, ?, ?, ?)`,
    [orderId, from, to, note, userId]
  );

  return { ok: true, from, to };
}

/**
 * Recomputes the cached stock level from the ledger.
 *
 * items.qty is a cache of SUM(stock_movements.change_qty) and is never written
 * on its own — always this, in the same transaction as the movement row that
 * changed it.
 */
async function recomputeItemQty(conn, itemId) {
  await conn.query(
    `UPDATE items SET qty = (SELECT COALESCE(SUM(change_qty), 0) FROM stock_movements WHERE item_id = ?)
     WHERE masterid = ?`,
    [itemId, itemId]
  );
}

/**
 * Writes a movement and refreshes the cache together.
 *
 * `change` is signed: negative removes stock, positive adds it. There is no
 * "correct a movement" path because there is no such thing — a mistake is a new
 * opposing row, which is why the ledger can always explain a level.
 */
async function moveStock(conn, { itemId, change, reason, refType, refId, note, userId }) {
  await conn.query(
    `INSERT INTO stock_movements (item_id, change_qty, reason, ref_type, ref_id, note, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [itemId, qty(change), reason, refType || null, refId || null, note || null, userId || null]
  );
  await recomputeItemQty(conn, itemId);
}

/**
 * Recomputes a party's outstanding balance from the documents behind it.
 *
 *   closing_balance = issued invoices - payments received - issued credit notes
 *
 * customers.closing_balance is a cache in exactly the way items.qty is: it
 * exists so a list screen can sort by ageing without three subqueries, and it is
 * only ever written here, inside the transaction that changed one of its inputs.
 *
 * Pending credit notes are deliberately excluded. A credit that has been agreed
 * but not issued is not yet money the party may set against their account —
 * counting it early understates what they owe, which is the whole distinction
 * the `pending` status exists to draw.
 */
async function recomputeBalance(conn, customerId) {
  await conn.query(
    `UPDATE customers c SET c.closing_balance = (
       COALESCE((SELECT SUM(i.grand_total) FROM invoices i
                  WHERE i.customer_id = c.masterid AND i.status = 'issued'), 0)
     - COALESCE((SELECT SUM(p.amount) FROM payments p
                  WHERE p.customer_id = c.masterid AND p.status = 'received'), 0)
     - COALESCE((SELECT SUM(n.amount) FROM credit_notes n
                  WHERE n.customer_id = c.masterid AND n.status = 'issued'), 0)
     ) WHERE c.masterid = ?`,
    [customerId]
  );
}

/**
 * Raises an alert.
 *
 * `userId: null` is a broadcast — everyone who can read alerts sees it. A value
 * targets one person, which is how a verify mismatch reaches Yash specifically.
 *
 * Never throws into the caller's transaction: an alert that could not be written
 * must not roll back the delivery it was announcing. It is logged instead.
 */
async function notify(conn, { userId = null, tone = 'info', title, body = null, actor = null, refType = null, refId = null }) {
  try {
    await conn.query(
      `INSERT INTO notifications (user_id, tone, title, body, actor, ref_type, ref_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId, tone, title, body, actor, refType, refId]
    );
  } catch (err) {
    console.error('[NOTIFY] could not record alert:', err.sqlMessage || err.message);
  }
}

/**
 * Everyone holding a grant, for alerts that must reach a role rather than a
 * person — "a mismatch was found" goes to whoever can act on it, not to a name
 * hard-coded in a route.
 *
 * Matches the wildcard and the area grant. It deliberately does not expand
 * action grants: an alert is a duty, and someone holding only `orders.view` is
 * not on the hook for one.
 */
async function usersWithGrant(conn, area) {
  const [rows] = await conn.query(
    `SELECT id FROM users
      WHERE is_active = TRUE
        AND (JSON_CONTAINS(permissions, '"all"') OR JSON_CONTAINS(permissions, JSON_QUOTE(?)))`,
    [area]
  );
  return rows.map((row) => row.id);
}

/**
 * Everyone who *can do* an action, by the same rules `userCan` applies.
 *
 * `usersWithGrant` matches the wildcard or the string given, and nothing else.
 * That is correct for an AREA name — `usersWithGrant(conn, 'dispatch')` finds
 * everyone who does dispatch — and quietly wrong for a dotted action, because a
 * grant covers everything beneath it. Manas holds `orders`, which satisfies
 * `orders.approve` on every route guard in the app; asking for the notification
 * audience the other way round found only the wildcard holders, so **Manas was
 * never told about a new order** — the notification R-01 exists to send. Gaurav
 * (`billing`) and Sonu (`purchases`) had the same hole.
 *
 * So: 'all', or the exact action, or the area it belongs to. One extra clause,
 * and it makes the audience for a message the same set as the people the route
 * would let act on it.
 */
async function usersWhoCan(conn, action) {
  const area = String(action).split('.')[0];
  const [rows] = await conn.query(
    `SELECT id FROM users
      WHERE is_active = TRUE
        AND (JSON_CONTAINS(permissions, '"all"')
          OR JSON_CONTAINS(permissions, JSON_QUOTE(?))
          OR JSON_CONTAINS(permissions, JSON_QUOTE(?)))`,
    [action, area]
  );
  return rows.map((row) => row.id);
}

/**
 * Users holding a grant *explicitly* — the wildcard does not count.
 *
 * `usersWithGrant` is right for telling people about something: an owner
 * holding "all" should hear about a below-cost sale, and that is what the
 * wildcard means.
 *
 * Assigning WORK is the opposite case. "The application randomly assigns 5
 * items to designated staff members (Ajit and Hirak) for a physical count" —
 * asking for `stock_count.post` the usual way handed the owners a daily
 * counting task apiece, because "all" satisfies every check. A duty is held by
 * whoever was given it, not by whoever could grant it to themselves.
 */
async function usersHoldingExactly(conn, grant) {
  const [rows] = await conn.query(
    `SELECT id FROM users
      WHERE is_active = TRUE AND JSON_CONTAINS(permissions, JSON_QUOTE(?))`,
    [grant]
  );
  return rows.map((row) => row.id);
}

/**
 * Next document number in a series, allocated inside the caller's transaction.
 *
 * Reads the current maximum with the table locked, so two concurrent bills
 * cannot both see the same last number. The UNIQUE key on the column is still
 * the backstop — this makes a collision rare, the constraint makes it
 * impossible.
 */
async function nextDocNumber(conn, { table, column, prefix, width = 4 }) {
  const [[row]] = await conn.query(
    `SELECT ${column} AS last FROM ${table}
      WHERE ${column} LIKE ?
      ORDER BY LENGTH(${column}) DESC, ${column} DESC
      LIMIT 1 FOR UPDATE`,
    [`${prefix}%`]
  );

  const lastNumber = row?.last ? parseInt(String(row.last).replace(prefix, ''), 10) : 0;
  const next = (Number.isFinite(lastNumber) ? lastNumber : 0) + 1;
  return `${prefix}${String(next).padStart(width, '0')}`;
}

module.exports = {
  money,
  qty,
  TRANSITIONS,
  canTransition,
  transition,
  recomputeItemQty,
  recomputeBalance,
  moveStock,
  notify,
  usersWithGrant,
  usersWhoCan,
  usersHoldingExactly,
  nextDocNumber,
};
