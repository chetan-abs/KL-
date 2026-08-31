/**
 * The pages the portal can grant access to, and the actions available on each.
 *
 * A grant is the string `${page}.${action}` — 'employees.create' — which is the
 * shape backend/utils/permissions.js already matches, so nothing new had to be
 * taught to userCan(). `page` is the key the navigator switches on — MobileNavigator
 * for the live app, RootNavigator for the old web panel — so a page
 * listed here must exist in the navigator or the grant buys the user nothing.
 *
 * The wildcard is what create-admin.js writes for the first admin. It satisfies
 * every check, which is why an account holding it is not narrowed by this grid.
 *
 * Orders, items and customers were absent from this list while their routes
 * were also ungated on the server: there was nothing to grant and nothing
 * enforcing it, so any signed-in account could read every order and every
 * customer. The routes are guarded now, and these are the grants that open them.
 */
export const WILDCARD = 'all';

export const PERMISSION_PAGES = [
  { key: 'employees', label: 'Employees', page: 'employees' },
  { key: 'attendance', label: 'Attendance', page: 'attendance' },
  { key: 'live_tracking', label: 'Live Tracking', page: 'liveTracking' },
  { key: 'orders', label: 'Orders', page: 'orderQueue', actions: ['view', 'create', 'edit', 'delete', 'approve'] },
  // 'rates' (see) and 'pricing' (change) are two different grants because R-04
  // and R-07 are two different rules: only Gaurav may CHANGE a rate, and only
  // Sonu may not SEE one. Collapsing them left every salesman with an item list
  // carrying no rates — an order screen that cannot price an order.
  //
  // They are siblings on purpose. Named 'rates' and 'rates.edit' they were
  // parent and child, and a grant covers everything beneath it: 'items.rates'
  // then satisfied 'items.rates.edit' and gave the whole field force the rate
  // card.
  { key: 'items', label: 'Item Master', page: 'newItem',
    actions: ['view', 'create', 'edit', 'delete', 'rates', 'pricing'] },
  { key: 'customers', label: 'Customers', page: 'register' },

  // The pipeline areas. Each names the duty rather than a CRUD row, because
  // that is what is actually being handed to a person: `picking.record` is
  // "may mark what came off the rack", and there is no sensible "delete".
  { key: 'picking', label: 'Picking', page: 'pickList', actions: ['view', 'record'] },
  { key: 'verification', label: 'Verification', page: 'verifyList', actions: ['view', 'record'] },
  { key: 'billing', label: 'Billing', page: 'invoiceList', actions: ['view', 'create'] },
  { key: 'dispatch', label: 'Dispatch', page: 'dispatchSheet', actions: ['view', 'build'] },
  { key: 'agents', label: 'Commission Agents', page: 'commissionAgent', actions: ['view', 'create', 'edit'] },
  // 'verify' is Sonu's physical review (5.1) and is what releases an entry
  // taken in by Sujay or Dishal for the Tally posting. Separate from
  // 'create' because the two must not be the same person.
  { key: 'purchases', label: 'Purchase', page: 'purchase',
    actions: ['view', 'create', 'edit', 'verify'] },
  { key: 'returns', label: 'Sales Returns', page: 'salesReturn', actions: ['view', 'create', 'accept'] },
  { key: 'estimates', label: 'Estimates', page: 'createEstimate', actions: ['view', 'create'] },
  // 'manage' activates a scheme and issues a growth-scheme award. Activating
  // one starts accruing money against every dealer invoice, so it is a
  // deliberate act by somebody senior rather than part of 'create'.
  { key: 'schemes', label: 'Schemes', page: 'scheme',
    actions: ['view', 'create', 'manage'] },
  // 'deposit' is Damodar's: he carries the cheque to the bank and uploads the
  // slip (R-06). 'manage' is Sibu's — recording, handing over, clearing.
  // Whoever hands a cheque over is not whoever confirms it arrived.
  { key: 'cheques', label: 'Cheques', page: 'chequeDeposit',
    actions: ['view', 'manage', 'deposit'] },
  { key: 'eod', label: 'End of Day', page: 'eod', actions: ['view', 'close'] },
  // 'manage' is Sibu counting a salesman's cash handover (section 8) and
  // closing the cash book. 'view' is enough to see what is coming in.
  { key: 'cash', label: 'Cash Book', page: 'eod', actions: ['view', 'manage'] },
  { key: 'stock_count', label: 'Stock Count', page: 'stockCount', actions: ['view', 'record', 'post'] },

  // Added with the August 2026 requirements. Each names a duty rather than a
  // CRUD row, for the same reason the pipeline areas do.
  //
  // `serverOnly` marks a grant whose API routes exist and are enforced but
  // which opens no screen. The grant is real — it gates /api/payroll,
  // /api/incentives and the rest — so an admin can hand it out and a script or
  // an integration can use it. What it does not do is put anything on a
  // navigator.
  //
  // The standing rule is that "a page named here must exist in the navigator or
  // the grant buys nothing". These are the exception, and they are flagged
  // rather than quietly listed so that nobody grants one expecting a screen to
  // appear.
  //
  // Six were flagged when the routes landed ahead of the UI. Five now have
  // screens and their `page` names the real route in `MobileNavigator`; the
  // flag came off with each. None of the five is a tab — the bar holds five
  // slots and each is spoken for by a duty somebody does hourly, so these are
  // reached from the screen they belong beside: pay from Profile, Tally from
  // the owner's dashboard.
  { key: 'payments', label: 'Receipts', page: 'register', actions: ['view', 'create'] },
  { key: 'salary', label: 'Salary', page: 'salary', actions: ['view', 'manage'] },
  // One screen carries both, so the page is the same for either grant.
  { key: 'leave', label: 'Leave', page: 'advances', actions: ['view', 'approve'] },
  { key: 'incentives', label: 'Incentives', page: 'incentive', actions: ['view', 'approve', 'pay'] },
  // Membership of the shared showroom incentive pool. A grant rather than a
  // list of names in code, so replacing Pulen is an admin action.
  //
  // Still `serverOnly`, and deliberately: it opens no screen at all. It marks
  // who the pool pays, which `routes/incentives.js` reads when it splits a
  // showroom segment. There is nothing for it to navigate to.
  { key: 'showroom', label: 'Showroom Pool', page: 'showroom', actions: ['view'], serverOnly: true },

  // Section 14. The queue holds every invoice, receipt and voucher in the
  // business as raw XML, which makes it a complete copy of the company's
  // commercial position in one table — so the audience is the owners and
  // whoever administers the integration, and nobody else.
  { key: 'tally', label: 'Tally Sync', page: 'tally', actions: ['view', 'manage'] },

  // The R-11 rate-change queue deliberately has NO grant of its own. Reading it
  // is `items.rates`, which already exists above, and deciding is the wildcard
  // — `approvesRates()` in `routes/items.js` checks for `all` and nothing else.
  // A `rate_changes` grant here would appear in the permission grid, be
  // handed out, and open nothing the server checks.
];

/** Grants whose routes are live but whose screen is still to be built. */
export const SERVER_ONLY_PAGES = PERMISSION_PAGES
  .filter((p) => p.serverOnly)
  .map((p) => p.key);

/**
 * The default action set, used by any page that does not name its own.
 *
 * Pages carry an optional `actions` array because the pipeline duties do not
 * fit view/create/edit/delete: there is no "delete a verification", and
 * "record" and "post" are the two distinct things a stock count can grant.
 * `actionsFor()` is what the grid should read, never this list directly.
 */
export const PERMISSION_ACTIONS = [
  { key: 'view', label: 'View' },
  { key: 'create', label: 'Create' },
  { key: 'edit', label: 'Edit' },
  { key: 'delete', label: 'Delete' },
];

/** Human labels for the actions that are not in the default four. */
const ACTION_LABELS = {
  view: 'View',
  create: 'Create',
  edit: 'Edit',
  delete: 'Delete',
  approve: 'Approve',
  record: 'Record',
  build: 'Build',
  accept: 'Accept',
  manage: 'Manage',
  close: 'Close',
  verify: 'Verify',
  deposit: 'Deposit',
  rates: 'See rates',
  pricing: 'Set rates',
  pay: 'Pay',
  post: 'Post',
};

/** The actions a given page offers, in the order they should be shown. */
export function actionsFor(page) {
  if (!page?.actions) return PERMISSION_ACTIONS;
  return page.actions.map((key) => ({ key, label: ACTION_LABELS[key] || key }));
}

// Pages every signed-in user reaches regardless of grants: the dashboard is the
// landing page, and Profile is their own account.
export const ALWAYS_VISIBLE_PAGES = ['dashboard', 'profile'];

/**
 * Grants that widen a page beyond the holder's own records.
 *
 * The server reads an *area* grant ('orders', not 'orders.view') as "may see
 * everyone's", which is how a salesman sees their own order book while a
 * supervisor sees the branch. The dashboard reads the same grant, so one
 * account sees one consistent scope rather than two.
 */
export const AREA_GRANT_WIDENS = {
  orders: 'Sees every salesman\'s orders and the company-wide dashboard, not only their own',
  estimates: 'Sees every salesman\'s quotes, not only their own',
};

/**
 * Areas whose *area* grant also makes the holder a recipient of that duty's
 * alerts — a verify mismatch goes to whoever holds `all`, a failed delivery to
 * whoever holds `dispatch`.
 *
 * Action grants are deliberately excluded: an alert is a duty, and someone
 * holding only `dispatch.view` is not on the hook for one. Kept here so the
 * grid can say so, and so `backend/utils/workflow.js` and this file cannot
 * disagree about who gets told.
 */
export const AREA_GRANT_NOTIFIES = {
  all: 'Receives verify mismatches and other owner-level alerts',
  picking: 'Told when an approved order is waiting in the godown',
  verification: 'Told when a picked order needs counting',
  billing: 'Told when a verified order is ready to bill',
  dispatch: 'Told when a delivery fails and needs re-scheduling',
};
