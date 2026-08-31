import { userCan } from '../utils/permissions';

/**
 * What each person's phone shows them.
 *
 * Derived from the signed-in account's grants, not from a role name. `role` is
 * deliberately not consulted anywhere — the server ignores it too, so
 * permissions are the single source of authority and revoking a grant actually
 * removes the tab.
 *
 * The duties in this business barely overlap: a driver has no register and a
 * picker has no order queue. So rather than one navigation tree with most of it
 * hidden, each account gets the tabs its grants actually open, capped at four —
 * the bar is 360pt wide and a fifth slot is unreadable.
 */

/**
 * Every tab the app can show, widest duty first.
 *
 * `permission` is the grant that opens it. `null` means everyone: Alerts and
 * Profile are the caller's own and are scoped by the server's WHERE clause
 * rather than by a grant.
 *
 * Order matters — this is the priority in which four slots are filled, so the
 * duty an account most specifically holds lands leftmost and becomes its home.
 */
export const ALL_TABS = [
  { key: 'yashDashboard', label: 'Business', icon: 'chart-box-outline', permission: 'all' },
  // Section 6 / C.5 and A.1 — who's in today, and who can create an account
  // and set its salary. Placed ahead of the pipeline duties: an account that
  // holds `attendance` or `employees.permissions` earns these deliberately,
  // not as a side effect of holding `all`, so they belong beside the tabs the
  // grant was given for rather than after them.
  { key: 'attendanceRegister', label: 'Attendance', icon: 'calendar-check-outline', permission: 'attendance' },
  { key: 'people', label: 'People', icon: 'account-group-outline', permission: 'employees.permissions' },
  // The item/rate catalog and its add-only spreadsheet import. Gaurav reaches
  // it for the same reason he reaches a rate at all — `items.pricing` — and
  // an owner's wildcard satisfies it too, which is also what gates the
  // import panel inside the screen itself.
  { key: 'itemCatalog', label: 'Items', icon: 'archive-outline', permission: 'items.pricing' },
  { key: 'orderQueue', label: 'Orders', icon: 'clipboard-text-outline', permission: 'orders.approve' },
  { key: 'pickList', label: 'Pick', icon: 'package-variant-closed', permission: 'picking.view' },
  { key: 'verifyList', label: 'Verify', icon: 'check-decagram-outline', permission: 'verification.view' },
  { key: 'invoiceList', label: 'Invoice', icon: 'receipt', permission: 'billing.view' },
  { key: 'purchase', label: 'Purchase', icon: 'cart-outline', permission: 'purchases.view' },
  { key: 'eod', label: 'EOD', icon: 'cash-register', permission: 'eod.view' },
  // Keyed on `estimates.create` rather than `orders.create`, because the `orders`
  // area grant satisfies the latter — which handed Manas a salesman's dashboard
  // simply for being able to approve. Quoting is the thing only a salesman does.
  { key: 'salesmanDashboard', label: 'Today', icon: 'view-dashboard-outline', permission: 'estimates.create' },
  { key: 'driverRoute', label: 'Route', icon: 'map-marker-path', permission: null, driverOnly: true },
  { key: 'driverHistory', label: 'Done', icon: 'check-all', permission: null, driverOnly: true },

  // Second-rank tabs: real duties, but ones an account only sees if it has room
  // left after its primary ones.
  { key: 'dispatchSheet', label: 'Dispatch', icon: 'truck-outline', permission: 'dispatch.view' },
  { key: 'stockCount', label: 'Count', icon: 'clipboard-list-outline', permission: 'stock_count.view' },
  { key: 'creditNote', label: 'Credit', icon: 'file-undo-outline', permission: 'returns.view' },
  { key: 'chequeDeposit', label: 'Cheques', icon: 'checkbook', permission: 'cheques.view' },
  { key: 'rateAlert', label: 'Rates', icon: 'trending-up', permission: 'purchases.view' },
  { key: 'register', label: 'Register', icon: 'file-document-outline', permission: 'payments.view' },
  { key: 'beatPlan', label: 'Beat', icon: 'map-marker-radius-outline', permission: 'estimates.create' },
  { key: 'createEstimate', label: 'Estimate', icon: 'calculator-variant-outline', permission: 'estimates.create' },
  { key: 'newItem', label: 'New Item', icon: 'plus-box-outline', permission: 'items.create' },
];

/** Always present, always last. Both are the caller's own and need no grant. */
const FIXED_TABS = [
  { key: 'notifications', label: 'Alerts', icon: 'bell-outline', permission: null },
  { key: 'profile', label: 'Profile', icon: 'account-outline', permission: null },
];

/**
 * Seven, not five.
 *
 * Was five until Attendance, People and Items joined the roster: an account
 * holding `all` earns all three alongside its widest operational duties, and
 * cropping lower would mean Business, Attendance, People, Items or Orders
 * loses its tab for no reason but arrival order. Nothing below is exempt from
 * the cap; it just moved twice.
 *
 * Anything still overflowing is linked from the screen it belongs beside rather
 * than dropped — New Item from Purchase, the scheme from the salesman's day.
 */
const MAX_TABS = 7;

/**
 * A driver holds almost nothing — every route they use is scoped to their own
 * id and needs no grant at all — so there is no permission that identifies one.
 * An account with no duty-bearing grant beyond reading orders is treated as
 * field delivery staff, which is what such an account is.
 */
function looksLikeDriver(user) {
  const duties = ALL_TABS.filter((tab) => tab.permission && tab.permission !== 'all');
  return !duties.some((tab) => userCan(user, tab.permission));
}

/**
 * The tabs this account gets: its duties, then Alerts and Profile.
 *
 * Capped at four including the fixed pair, so an account holding everything —
 * Yash — shows its widest duty plus Alerts and Profile rather than a bar of
 * nineteen.
 */
export function tabsFor(user) {
  if (!user) return FIXED_TABS;

  const earned = ALL_TABS.filter((tab) => {
    if (tab.driverOnly) return looksLikeDriver(user);
    if (!tab.permission) return true;
    return userCan(user, tab.permission);
  });

  return [...earned.slice(0, MAX_TABS - FIXED_TABS.length), ...FIXED_TABS];
}

/** Where this account lands after sign-in: its first earned tab. */
export function homeFor(user) {
  return tabsFor(user)[0]?.key || 'notifications';
}

/**
 * Job titles for the seeded staff accounts, read by `titleFor()` to label a
 * signed-in user. Presentation only — the grants that matter are on the row.
 *
 * This used to feed tap-to-fill chips on the login screen as well. Those are
 * gone: a list of valid usernames on a sign-in form undoes the server's
 * deliberate refusal to confirm which accounts exist. Nothing here is shown to
 * anybody who has not already signed in.
 */
export const ROLES = {
  manas: { key: 'manas', name: 'Manas', title: 'Approvals' },
  monu: { key: 'monu', name: 'Monu', title: 'Field Sales' },
  ashish: { key: 'ashish', name: 'Ashish', title: 'Picking' },
  ajit: { key: 'ajit', name: 'Ajit', title: 'Verify & Dispatch' },
  gaurav: { key: 'gaurav', name: 'Gaurav', title: 'Billing' },
  kamal: { key: 'kamal', name: 'Kamal', title: 'Delivery' },
  sonu: { key: 'sonu', name: 'Sonu', title: 'Purchase' },
  sibu: { key: 'sibu', name: 'Sibu', title: 'Cash & Close' },
  yash: { key: 'yash', name: 'Yash', title: 'Owner' },
};

/** The title to show beside a signed-in user's name, if we know one. */
export function titleFor(user) {
  return ROLES[String(user?.id || '').toLowerCase()]?.title || 'Staff';
}
