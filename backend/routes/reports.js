const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { userCan } = require('../utils/permissions');

router.use(authenticate);

// This module used to carry four more reports — customer groups, an onboarding
// log, a ledger, and a GPS audit trail — behind a Reports page that has been
// removed. The GPS trail is still readable on the Live Tracking page, which is
// where it belongs and which takes the same live_tracking.view grant. What is
// left here is the dashboard, because the home screen is built on it.

// mysql2 hands back DECIMAL columns as strings so no precision is lost on the
// way out of the driver. That is right for money rows, but the dashboard only
// reports aggregates the client does arithmetic on, so this endpoint states a
// numeric contract instead of making every caller remember to parse.
const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

// GET /api/reports/dashboard — the tiles on the home screen.
//
// Deliberately not permission-gated: every signed-in user sees this on launch,
// and what they see is their OWN day. The `orders` area grant widens it to the
// whole company — the same grant that decides whether the order list shows
// everyone's book or only the caller's, so a supervisor sees one consistent
// scope rather than two. Previously any authenticated account got company-wide
// revenue whether or not it was granted anything at all.
router.get('/dashboard', async (req, res, next) => {
  try {
    const companyWide = userCan(req.user, 'orders');
    const scope = companyWide ? '' : ' AND o.created_by = ?';
    const scopeParam = companyWide ? [] : [req.user.id];

    const today = new Date().toISOString().split('T')[0];
    const currentMonth = today.slice(0, 7); // YYYY-MM

    // A no-order visit is flagged by its own column now, so a genuinely
    // cancelled order is no longer counted as an unproductive visit.
    const [[todayOrders]] = await pool.query(
      `SELECT COUNT(*) AS count, COALESCE(SUM(total_amount), 0) AS total_val
         FROM orders o
        WHERE o.order_date = ? AND o.status != 'cancelled' AND o.is_no_order = FALSE${scope}`,
      [today, ...scopeParam]
    );

    const [[todayNoOrders]] = await pool.query(
      `SELECT COUNT(*) AS count FROM orders o
        WHERE o.order_date = ? AND o.is_no_order = TRUE${scope}`,
      [today, ...scopeParam]
    );

    const [[todayItems]] = await pool.query(
      `SELECT COALESCE(SUM(oi.qty), 0) AS count
         FROM order_items oi JOIN orders o ON oi.order_id = o.order_id
        WHERE o.order_date = ? AND o.status != 'cancelled'${scope}`,
      [today, ...scopeParam]
    );

    // Items sold and sales value are two separate aggregates over two different
    // grains. Joining order_items to orders and summing o.total_amount counted
    // the order total once per line, so a three-line order reported three times
    // its value as revenue.
    const [[monthlyItems]] = await pool.query(
      `SELECT COALESCE(SUM(oi.qty), 0) AS count
         FROM order_items oi JOIN orders o ON oi.order_id = o.order_id
        WHERE DATE_FORMAT(o.order_date, '%Y-%m') = ? AND o.status != 'cancelled'${scope}`,
      [currentMonth, ...scopeParam]
    );

    const [[monthlySales]] = await pool.query(
      `SELECT COALESCE(SUM(o.total_amount), 0) AS val
         FROM orders o
        WHERE DATE_FORMAT(o.order_date, '%Y-%m') = ? AND o.status != 'cancelled' AND o.is_no_order = FALSE${scope}`,
      [currentMonth, ...scopeParam]
    );

    const [[monthlyVisits]] = await pool.query(
      `SELECT COUNT(DISTINCT o.customer_id) AS total_shops, COUNT(*) AS total_visits
         FROM orders o
        WHERE DATE_FORMAT(o.order_date, '%Y-%m') = ?${scope}`,
      [currentMonth, ...scopeParam]
    );

    res.json({
      scope: companyWide ? 'company' : 'self',
      today: {
        ordersTaken: num(todayOrders.count),
        ordersValue: num(todayOrders.total_val),
        noOrders: num(todayNoOrders.count),
        itemsSold: num(todayItems.count)
      },
      monthly: {
        itemsSold: num(monthlyItems.count),
        totalSalesValue: num(monthlySales.val),
        totalShopsVisited: num(monthlyVisits.total_shops),
        totalVisits: num(monthlyVisits.total_visits)
      }
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
