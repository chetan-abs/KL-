const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authenticate, requirePermission } = require('../middleware/auth');
const { userCan } = require('../utils/permissions');
const { businessDay } = require('../utils/businessDay');
const { placeFor } = require('../utils/geocode');
const { moveStock, notify, usersWithGrant, usersWhoCan, nextDocNumber } = require('../utils/workflow');
const {
  rateFor, commissionFor, qualifyingValue, isBelowCost,
  assertSchemeCommissionExclusive, requiredWindow, isCustomerType, label,
} = require('../utils/pricing');

router.use(authenticate);

/**
 * Whether the caller may see orders other than their own.
 *
 * userCan(user, 'orders') is true only for the area grant or the wildcard —
 * an action grant like 'orders.view' does not satisfy a one-segment check. So
 * a salesman holding 'orders.view' sees their own book, and a supervisor
 * holding 'orders' (or an admin holding 'all') sees everyone's. Before this,
 * any authenticated account could list every order in the company.
 */
function seesAllOrders(user) {
  return userCan(user, 'orders') || worksThePipeline(user);
}

/**
 * Whether the caller handles orders as a duty rather than as their own book.
 *
 * A picker, a verifier, a biller and a dispatcher all act on orders somebody
 * else raised — that is the entire job — so scoping them to `created_by` hid
 * every order they were supposed to work on and the pipeline simply stopped:
 * Ajit could not open the order he was asked to count.
 *
 * These grants are deliberately *not* folded into `orders` itself. The area
 * grant also widens the dashboard to company-wide figures, and a picker needing
 * to read a line item is not a reason to show them the branch's sales.
 */
function worksThePipeline(user) {
  return ['picking', 'verification', 'billing', 'dispatch'].some((area) => userCan(user, area));
}

// Money is computed here and stored to DECIMAL(15,2), so every intermediate is
// rounded to paise before it is added up. Summing unrounded floats and rounding
// once at the end drifts from the sum of the line totals the customer is shown.
const money = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// GET /api/orders — List orders
router.get('/', requirePermission('orders.view'), async (req, res, next) => {
  try {
    const { status, customer_id, date, created_by } = req.query;
    // The party's balance and the age of their oldest unpaid invoice ride along
    // with the row. The approval queue's whole job is deciding whether to extend
    // more credit to this party, and a second round trip per row to answer that
    // is what makes a list screen feel broken on a field phone.
    let sql = `
      SELECT o.*, c.name AS customer_name, c.group_name AS customer_group,
             c.closing_balance AS outstanding, c.credit_limit,
             u.name AS salesman_name,
             (SELECT DATEDIFF(CURDATE(), MIN(i.invoice_date))
                FROM invoices i
               WHERE i.customer_id = c.masterid AND i.status = 'issued') AS outstanding_days
      FROM orders o
      JOIN customers c ON o.customer_id = c.masterid
      LEFT JOIN users u ON o.created_by = u.id
      WHERE 1=1
    `;
    const params = [];

    // Applied before the caller's own filters so it cannot be widened by one.
    if (!seesAllOrders(req.user)) {
      sql += ' AND o.created_by = ?';
      params.push(req.user.id);
    }

    if (status) {
      sql += ' AND o.status = ?';
      params.push(status);
    }
    if (customer_id) {
      sql += ' AND o.customer_id = ?';
      params.push(customer_id);
    }
    if (date) {
      sql += ' AND o.order_date = ?';
      params.push(date);
    }
    if (created_by) {
      sql += ' AND o.created_by = ?';
      params.push(created_by);
    }

    sql += ' ORDER BY o.created_at DESC';
    const [orders] = await pool.query(sql, params);
    res.json({ orders });
  } catch (err) {
    next(err);
  }
});

// GET /api/orders/:id — Get single order with line items
router.get('/:id', requirePermission('orders.view'), async (req, res, next) => {
  try {
    const [orders] = await pool.query(
      `SELECT o.*, c.name AS customer_name, c.group_name AS customer_group,
              c.phone AS customer_phone, c.city AS customer_city, c.address AS customer_address,
              c.closing_balance AS outstanding, c.credit_limit,
              u.name AS salesman_name,
              (SELECT DATEDIFF(CURDATE(), MIN(i.invoice_date))
                 FROM invoices i
                WHERE i.customer_id = c.masterid AND i.status = 'issued') AS outstanding_days
       FROM orders o
       JOIN customers c ON o.customer_id = c.masterid
       LEFT JOIN users u ON o.created_by = u.id
       WHERE o.order_id = ?`,
      [req.params.id]
    );

    if (orders.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orders[0];
    if (!seesAllOrders(req.user) && order.created_by !== req.user.id) {
      // Same body as a genuine miss: whether an order id exists is not
      // something a caller who may not read it should be able to probe.
      return res.status(404).json({ error: 'Order not found' });
    }

    const [items] = await pool.query(
      'SELECT * FROM order_items WHERE order_id = ?',
      [order.order_id]
    );

    res.json({ order: { ...order, items } });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/orders — raise a sales order.
 *
 * Section 4.1 of the requirements, and the point at which most of the business
 * rules bite. In order:
 *
 *   · the party decides the rate column (3, and utils/pricing.js)
 *   · the party's salesman is tagged permanently on first order
 *   · a commission type demands an agent; an electrician demands a scheme
 *     member; R-22 forbids both
 *   · every rate is computed here from the item master, never accepted from
 *     the request
 *   · a split payment must add up exactly (R-23)
 *   · the submitting salesman's GPS fix is stamped on and cannot be edited
 *     afterwards (R-26)
 *   · a similar order in the last 24 hours must be acknowledged
 *   · a party 60 days overdue produces a warning, never a block (R-17)
 */
router.post('/', requirePermission('orders.create'), async (req, res, next) => {
  try {
    const {
      customer_id,
      customer_type: requestedType,
      order_date = businessDay(),
      items = [],
      notes = '',
      is_no_order = false,
      no_order_reason = '',
      salesman_id: requestedSalesman = null,
      agent_id = null,
      agent_type = 'electrician',
      scheme_member_id = null,
      delivered_to = null,
      delivery_mode = null,
      urgency = null,
      special_instructions = null,
      payment_mode = null,
      payment_splits = [],
      gps = null,
      duplicate_ack = false,
      // 4.1, "Order Photo": "Optional: The user may photograph a handwritten
      // order note for reference."
      //
      // Optional, and enforced as optional — unlike the four photographs R-06
      // makes mandatory, a missing one here is not an error. What IS checked is
      // that an id which was sent refers to a real upload by this user, because
      // a silently-dropped bad id would look like a photograph nobody can find.
      order_photo_id = null,
    } = req.body;

    if (!customer_id) return res.status(400).json({ error: 'Customer ID is required' });
    if (!Array.isArray(items)) return res.status(400).json({ error: 'Items must be a list' });
    if (!is_no_order && items.length === 0) {
      return res.status(400).json({ error: 'An order needs at least one item' });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [[customer]] = await conn.query(
        `SELECT masterid, name, customer_type, salesman_id, credit_limit, closing_balance
           FROM customers WHERE masterid = ? AND is_active = TRUE FOR UPDATE`,
        [customer_id],
      );

      // Validated before anything is written, so a bad id fails the request
      // rather than leaving an order pointing at nothing.
      if (order_photo_id) {
        const [[shot]] = await conn.query(
          'SELECT id, uploaded_by FROM attachments WHERE id = ?', [Number(order_photo_id)]);
        if (!shot) {
          await conn.rollback();
          return res.status(400).json({
            error: 'That order photograph was not found.', code: 'PHOTO_NOT_FOUND' });
        }
        if (shot.uploaded_by !== req.user.id) {
          await conn.rollback();
          return res.status(400).json({
            error: 'That photograph belongs to somebody else.', code: 'PHOTO_NOT_YOURS' });
        }
      }
      if (!customer) {
        await conn.rollback();
        return res.status(400).json({ error: 'Customer not found' });
      }

      // ---- a no-order visit ends here -----------------------------------
      // It records that the call happened and produced nothing. It has no
      // items, no rate and no pipeline; the flag is what the dashboard counts.
      if (is_no_order) {
        const [res0] = await conn.query(
          `INSERT INTO orders (customer_id, customer_type, order_date, total_amount, created_by,
                               salesman_id, status, notes, is_no_order, gps_lat, gps_lng, gps_place)
           VALUES (?, ?, ?, 0, ?, ?, 'cancelled', ?, TRUE, ?, ?, ?)`,
          [customer_id, customer.customer_type, order_date, req.user.id,
            customer.salesman_id || req.user.id,
            `[NO ORDER REASON]: ${no_order_reason || 'No order placed'}${notes ? ' - ' + notes : ''}`,
            gps?.lat ?? null, gps?.lng ?? null, gps?.place ?? null],
        );
        await conn.commit();
        return res.status(201).json({ message: 'Checkout recorded (No Order)', order_id: res0.insertId, total_amount: 0 });
      }

      // ---- customer type -------------------------------------------------
      // The party's own classification is the default; the order screen may
      // override it for this order (a dealer buying at retail for himself),
      // but it must still be one of the six — an unknown string would reach
      // the pricing engine and price nothing.
      const customerType = requestedType || customer.customer_type;
      if (!customerType) {
        await conn.rollback();
        return res.status(400).json({
          error: `${customer.name} has no customer type set. Classify the party before ordering — the type decides the rate.`,
          code: 'NO_CUSTOMER_TYPE',
        });
      }
      if (!isCustomerType(customerType)) {
        await conn.rollback();
        return res.status(400).json({ error: `"${customerType}" is not a customer type.`, code: 'BAD_CUSTOMER_TYPE' });
      }

      // ---- the window the type demands ------------------------------------
      const window = requiredWindow(customerType);
      if (window === 'agent' && !agent_id) {
        await conn.rollback();
        return res.status(400).json({
          error: `${label(customerType)} orders must name the commission agent who brought the customer.`,
          code: 'AGENT_REQUIRED',
        });
      }
      if (window === 'scheme' && !scheme_member_id) {
        await conn.rollback();
        return res.status(400).json({
          error: 'Electrician Direct orders must be tied to a KL Utsav member. Register the electrician first.',
          code: 'SCHEME_MEMBER_REQUIRED',
        });
      }
      // R-22, and it is checked even when the window did not ask for both —
      // a client that sent an agent on an electrician order would otherwise
      // have paid a commission and credited the scheme on one sale.
      try {
        assertSchemeCommissionExclusive({ agentId: agent_id, schemeMemberId: scheme_member_id });
      } catch (err) {
        await conn.rollback();
        return res.status(400).json({ error: err.message, code: err.code });
      }

      if (agent_id) {
        const [[agent]] = await conn.query('SELECT id FROM agents WHERE id = ? AND is_active = TRUE', [agent_id]);
        if (!agent) {
          await conn.rollback();
          return res.status(400).json({ error: 'That agent is not on file.', code: 'AGENT_NOT_FOUND' });
        }
      }
      if (scheme_member_id) {
        const [[member]] = await conn.query(
          `SELECT m.id FROM scheme_members m JOIN schemes s ON s.id = m.scheme_id
            WHERE m.id = ? AND s.is_active = TRUE`, [scheme_member_id]);
        if (!member) {
          await conn.rollback();
          return res.status(400).json({ error: 'That scheme member is not on a live scheme.', code: 'MEMBER_NOT_FOUND' });
        }
      }

      // ---- delivery ------------------------------------------------------
      // "Mandatory. The name of the person who will physically receive the
      // goods... This is not the party name."
      if (!delivered_to || !String(delivered_to).trim()) {
        await conn.rollback();
        return res.status(400).json({
          error: 'Name the person who will receive the goods — not the party, the individual.',
          code: 'DELIVERED_TO_REQUIRED',
        });
      }

      // ---- the salesman tag ----------------------------------------------
      // "If the party is already tagged to a salesman, the field is auto-filled
      // and locked." The lock is here, not in the UI: the stored tag wins over
      // whatever the request sent.
      const salesmanId = customer.salesman_id || requestedSalesman || req.user.id;

      // ---- duplicate detection -------------------------------------------
      const [[recent]] = await conn.query(
        `SELECT order_id, so_number, order_date FROM orders
          WHERE customer_id = ? AND is_no_order = FALSE
            AND status NOT IN ('cancelled','rejected')
            AND created_at >= (NOW() - INTERVAL 24 HOUR)
          ORDER BY order_id DESC LIMIT 1`,
        [customer_id],
      );
      if (recent && !duplicate_ack) {
        await conn.rollback();
        return res.status(409).json({
          error: `A similar order was placed for ${customer.name} on ${recent.order_date} — ${recent.so_number || `#${recent.order_id}`}. Please confirm this is a new order.`,
          code: 'POSSIBLE_DUPLICATE',
          previous: { order_id: recent.order_id, so_number: recent.so_number, order_date: recent.order_date },
        });
      }

      // ---- lines ----------------------------------------------------------
      if (items.some((line) => !Number.isInteger(Number(line.item_id)))) {
        await conn.rollback();
        return res.status(400).json({ error: 'Every line needs a valid item_id' });
      }
      const ids = [...new Set(items.map((i) => Number(i.item_id)))];
      const [masters] = await conn.query(
        `SELECT masterid, name, hsn, gst_percent, cost_price,
                pricing_type, base_price,
                disc_dealer, disc_builder_direct, disc_builder_comm,
                disc_retail_direct, disc_retail_comm, disc_electrician,
                ratio_builder_direct, ratio_builder_comm, ratio_retail_direct,
                ratio_retail_comm, ratio_electrician,
                comm_retail_agent, comm_builder_agent, scheme_weightage
           FROM items WHERE masterid IN (?) AND is_active = TRUE FOR UPDATE`,
        [ids],
      );
      const masterById = new Map(masters.map((m) => [m.masterid, m]));

      let grandTotal = 0;
      let commissionTotal = 0;
      let qualifyingTotal = 0;
      const belowCostLines = [];
      const processedItems = [];

      for (const line of items) {
        const master = masterById.get(Number(line.item_id));
        if (!master) {
          await conn.rollback();
          return res.status(400).json({ error: `Item ${line.item_id} is not available` });
        }

        const qty = Number(line.qty);
        if (!Number.isFinite(qty) || qty <= 0) {
          await conn.rollback();
          return res.status(400).json({ error: `Quantity for ${master.name} must be greater than zero` });
        }

        // The rate is derived, never accepted. An item with no rate card
        // refuses rather than pricing at zero — 5,233 of the 8,885 items in
        // the master are in exactly that state.
        let priced;
        try {
          priced = rateFor(master, customerType);
        } catch (err) {
          await conn.rollback();
          if (err.name === 'PriceUnavailable') {
            return res.status(400).json({ error: err.message, code: err.code, item_id: master.masterid });
          }
          throw err;
        }

        // Discount and scheme are the salesman's to set; the rate is not.
        const discount = Math.min(Math.max(Number(line.discount) || 0, 0), 100);
        const scheme = Math.min(Math.max(Number(line.scheme) || 0, 0), 100);
        const gstPercent = Number(master.gst_percent) || 0;

        const net = money(qty * priced.rate * (1 - discount / 100));
        const gstAmount = money(net * (gstPercent / 100));
        const lineTotal = money(net + gstAmount);
        grandTotal = money(grandTotal + lineTotal);

        // "The previous rate (last sale price for this item) is displayed
        // alongside for reference." Read per line rather than in one join so a
        // party-specific history takes precedence over the general one.
        const [[prev]] = await conn.query(
          `SELECT rate FROM item_rate_history
            WHERE item_id = ? AND (customer_id = ? OR customer_id IS NULL)
            ORDER BY (customer_id = ?) DESC, billed_on DESC, id DESC LIMIT 1`,
          [master.masterid, customer_id, customer_id],
        );

        const belowCost = isBelowCost(master, priced.rate);
        if (belowCost) belowCostLines.push(`${master.name} at ${priced.rate} against cost ${master.cost_price}`);

        // Commission is on the net sale value, before GST — the agent is paid
        // on what the business earned, not on the tax it collected.
        const comm = agent_id ? commissionFor(master, agent_type, net) : { percent: null, amount: 0 };
        commissionTotal = money(commissionTotal + comm.amount);

        const qualifying = scheme_member_id ? qualifyingValue(master, net) : 0;
        qualifyingTotal = money(qualifyingTotal + qualifying);

        processedItems.push({
          item_id: master.masterid,
          item_name: master.name,
          hsn: master.hsn || '',
          qty,
          rate: priced.rate,
          pricing_type: priced.pricingType,
          base_price: priced.basePrice,
          price_factor: priced.factor,
          previous_rate: prev ? Number(prev.rate) : null,
          cost_price: master.cost_price,
          below_cost: belowCost,
          commission_pct: comm.percent,
          commission_amt: comm.amount,
          scheme_weightage: master.scheme_weightage,
          scheme_value: qualifying,
          scheme,
          discount,
          gst_percent: gstPercent,
          gst_amount: gstAmount,
          total: lineTotal,
        });
      }

      // ---- R-23: a split must add up exactly ------------------------------
      if (payment_mode === 'split') {
        const sum = payment_splits.reduce((a, s) => money(a + Number(s.amount || 0)), 0);
        if (Math.abs(sum - grandTotal) > 0.01) {
          await conn.rollback();
          return res.status(400).json({
            error: `Split payments total ${sum.toFixed(2)} but the order is ${grandTotal.toFixed(2)}. They must match exactly.`,
            code: 'SPLIT_MISMATCH',
            expected: grandTotal,
            received: sum,
          });
        }
      }

      // ---- the place name (D.2) -------------------------------------------
      // "Name of the location or nearest landmark (reverse geocoded from
      // coordinates)". A server-side geocode is stronger evidence than a string
      // the client typed, so it wins; the source is recorded either way,
      // because Yash reviewing where a salesman was needs to know which kind of
      // evidence he is looking at.
      //
      // GEOCODE_ENABLED is off by default: sending an identified employee's
      // coordinates to a third party is a decision for the business, not a
      // default a backend should choose. See utils/geocode.js.
      const located = await placeFor({
        lat: gps?.lat, lng: gps?.lng, clientPlace: gps?.place });

      // ---- write ----------------------------------------------------------
      // 'confirmed' when the creator may confirm, 'pending' otherwise. Both
      // mean "not yet approved" — R-01 still requires Manas.
      const orderStatus = userCan(req.user, 'orders.confirm') ? 'confirmed' : 'pending';
      const soNumber = await nextDocNumber(conn, {
        table: 'orders', column: 'so_number', prefix: 'SO-', width: 5,
      });

      const [orderResult] = await conn.query(
        `INSERT INTO orders (so_number, customer_id, customer_type, order_date, total_amount,
                             created_by, salesman_id, agent_id, agent_commission,
                             scheme_member_id, scheme_qualifying, status, notes,
                             delivered_to, delivery_mode, urgency, special_instructions,
                             payment_mode, gps_lat, gps_lng, gps_place, gps_place_source,
                             duplicate_ack, order_photo_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [soNumber, customer_id, customerType, order_date, grandTotal,
          req.user.id, salesmanId, agent_id, commissionTotal,
          scheme_member_id, qualifyingTotal, orderStatus, notes,
          String(delivered_to).trim(), delivery_mode, urgency, special_instructions,
          payment_mode, gps?.lat ?? null, gps?.lng ?? null,
          located.place, located.source,
          Boolean(duplicate_ack), order_photo_id ? Number(order_photo_id) : null],
      );
      const orderId = orderResult.insertId;

      for (const item of processedItems) {
        await conn.query(
          `INSERT INTO order_items
             (order_id, item_id, item_name, hsn, qty, rate, pricing_type, base_price,
              price_factor, previous_rate, cost_price, below_cost, commission_pct,
              commission_amt, scheme_weightage, scheme_value, scheme, discount,
              gst_percent, gst_amount, total)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [orderId, item.item_id, item.item_name, item.hsn, item.qty, item.rate,
            item.pricing_type, item.base_price, item.price_factor, item.previous_rate,
            item.cost_price, item.below_cost, item.commission_pct, item.commission_amt,
            item.scheme_weightage, item.scheme_value, item.scheme, item.discount,
            item.gst_percent, item.gst_amount, item.total],
        );

        await moveStock(conn, {
          itemId: item.item_id,
          change: -item.qty,
          reason: 'order',
          refType: 'order',
          refId: orderId,
          note: `Order ${soNumber}`,
          userId: req.user.id,
        });
      }

      if (payment_mode === 'split') {
        for (const s of payment_splits) {
          await conn.query(
            'INSERT INTO order_payment_splits (order_id, mode, amount, note) VALUES (?, ?, ?, ?)',
            [orderId, s.mode, money(Number(s.amount)), s.note || null],
          );
        }
      }

      // 4.1: the photograph is "accessible to Yash, Manas, Ajit, and the
      // relevant salesman" — the same audience as the order, so linking it to
      // the order is what grants that access. No separate ACL is needed.
      if (order_photo_id) {
        await conn.query(
          "UPDATE attachments SET ref_type = 'order_note', ref_id = ? WHERE id = ?",
          [orderId, Number(order_photo_id)]);
      }

      // "If the party is new, the user selects from a dropdown. The salesman is
      // then permanently tagged to this party." Written once, on the first
      // order, and never overwritten afterwards.
      if (!customer.salesman_id && salesmanId) {
        await conn.query('UPDATE customers SET salesman_id = ? WHERE masterid = ?', [salesmanId, customer_id]);
      }
      if (!customer.customer_type) {
        await conn.query('UPDATE customers SET customer_type = ? WHERE masterid = ?', [customerType, customer_id]);
      }

      // ---- notifications --------------------------------------------------
      // R-01: Manas is told about every order, immediately.
      for (const approver of await usersWhoCan(conn, 'orders.approve')) {
        await notify(conn, {
          userId: approver,
          tone: 'info',
          title: `New order ${soNumber}`,
          body: `${customer.name} — ${grandTotal.toFixed(2)}, raised by ${req.user.name}.`,
          actor: req.user.id,
          refType: 'order',
          refId: orderId,
        });
      }

      // R-16: below cost is a notification to Yash, never a block.
      if (belowCostLines.length) {
        for (const owner of await usersWithGrant(conn, 'all')) {
          await notify(conn, {
            userId: owner,
            tone: 'warning',
            title: `Below-cost pricing on ${soNumber}`,
            body: belowCostLines.join('; '),
            actor: req.user.id,
            refType: 'order',
            refId: orderId,
          });
        }
      }

      // R-17: a 60-day overdue balance is reported back with the order, for
      // the salesman to see and management to decide on. Not a block.
      const [[overdue]] = await conn.query(
        `SELECT COALESCE(SUM(grand_total - amount_paid), 0) AS amount, COUNT(*) AS invoices
           FROM invoices
          WHERE customer_id = ? AND settled_on IS NULL AND status <> 'cancelled'
            AND invoice_date < (CURDATE() - INTERVAL 60 DAY)`,
        [customer_id],
      );

      await conn.commit();

      res.status(201).json({
        message: 'Order created successfully',
        order_id: orderId,
        so_number: soNumber,
        total_amount: grandTotal,
        customer_type: customerType,
        agent_commission: commissionTotal,
        scheme_qualifying: qualifyingTotal,
        below_cost: belowCostLines,
        gps_place: located.place,
        gps_place_source: located.source,
        overdue_60: Number(overdue.amount) > 0
          ? { amount: Number(overdue.amount), invoices: overdue.invoices }
          : null,
      });
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

// PUT /api/orders/:id/status — Update order status
router.put('/:id/status', requirePermission('orders.edit'), async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!['pending', 'confirmed', 'completed', 'cancelled'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [[order]] = await conn.query(
        'SELECT order_id, status, created_by, is_no_order FROM orders WHERE order_id = ? FOR UPDATE',
        [req.params.id]
      );
      if (!order) {
        await conn.rollback();
        return res.status(404).json({ error: 'Order not found' });
      }
      if (!seesAllOrders(req.user) && order.created_by !== req.user.id) {
        await conn.rollback();
        return res.status(404).json({ error: 'Order not found' });
      }
      if (order.is_no_order) {
        await conn.rollback();
        return res.status(400).json({ error: 'A no-order visit has no status to change' });
      }

      const wasCancelled = order.status === 'cancelled';
      const willBeCancelled = status === 'cancelled';

      await conn.query('UPDATE orders SET status = ? WHERE order_id = ?', [status, req.params.id]);

      // Cancelling used to change the status and nothing else, so the stock the
      // order consumed never came back: items.qty stayed low until somebody
      // noticed and adjusted by hand. The ledger is append-only, so the
      // correction is an opposing row — never an edit or a delete of the
      // original movement.
      if (wasCancelled !== willBeCancelled) {
        const [lines] = await conn.query('SELECT item_id, qty FROM order_items WHERE order_id = ?', [req.params.id]);
        const direction = willBeCancelled ? 1 : -1;

        for (const line of lines) {
          await conn.query(
            `INSERT INTO stock_movements (item_id, change_qty, reason, ref_type, ref_id, note, created_by)
             VALUES (?, ?, 'adjustment', ?, ?, ?, ?)`,
            [
              line.item_id,
              direction * Number(line.qty),
              willBeCancelled ? 'order-cancel' : 'order-reinstate',
              req.params.id,
              willBeCancelled ? 'Stock returned by order cancellation' : 'Stock taken again by order reinstatement',
              req.user.id
            ]
          );
          await conn.query(
            `UPDATE items SET qty = (SELECT COALESCE(SUM(change_qty), 0) FROM stock_movements WHERE item_id = ?)
             WHERE masterid = ?`,
            [line.item_id, line.item_id]
          );
        }
      }

      await conn.commit();
      res.json({ message: 'Order status updated successfully' });
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
