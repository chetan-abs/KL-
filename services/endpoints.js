import api from './api';

/**
 * Every call the phone app makes, in one place.
 *
 * Screens import from here rather than reaching for axios, so a route that moves
 * is renamed once instead of in fourteen components — and so the shape of the
 * API is readable without opening the server.
 *
 * Each function returns the response body directly. `api` already throws on a
 * non-2xx, and the interceptor already turns an expired token into a sign-out,
 * so a caller that gets a value can trust it.
 */

const body = (promise) => promise.then((res) => res.data);

// ---------------------------------------------------------------------------
// Approval — Manas
// ---------------------------------------------------------------------------
export const Orders = {
  list: (params) => body(api.get('/orders', { params })),
  get: (id) => body(api.get(`/orders/${id}`)),
  /**
   * Section 4.1. The rate is NEVER sent — the server derives it from the party's
   * customer type. What the caller supplies is the party, the lines, who is
   * receiving the goods, and the GPS fix (R-26).
   *
   * Answers 409 POSSIBLE_DUPLICATE for a similar order in the last 24 hours;
   * resend with `duplicate_ack: true` once the salesman has confirmed.
   */
  create: (payload) => body(api.post('/orders', payload)),
  approve: (id, note) => body(api.post(`/workflow/orders/${id}/approve`, { note })),
  reject: (id, reason) => body(api.post(`/workflow/orders/${id}/reject`, { reason })),
  events: (id) => body(api.get(`/workflow/orders/${id}/events`)),
  /**
   * The old web-panel status setter. Cancelling returns the stock as opposing
   * `adjustment` movements in the same transaction; reinstating takes it again.
   */
  setStatus: (id, status) => body(api.put(`/orders/${id}/status`, { status })),
};

// ---------------------------------------------------------------------------
// Picking — Ashish
// ---------------------------------------------------------------------------
export const Picking = {
  queue: () => body(api.get('/workflow/picks')),
  sheet: (orderId) => body(api.get(`/workflow/orders/${orderId}/picksheet`)),
  /**
   * R-05 — the godown register. A pick on an order drawing from Berlia or Fan
   * is refused with GODOWN_REGISTER_REQUIRED until this has been called for
   * each of them.
   */
  acknowledgeRegister: (orderId, godown) =>
    body(api.post(`/workflow/orders/${orderId}/godown-register`,
      { godown, acknowledged: true })),
  record: (orderId, lines) => body(api.post(`/workflow/orders/${orderId}/pick`, { lines })),
  handover: (orderId) => body(api.post(`/workflow/orders/${orderId}/handover`, {})),
};

// ---------------------------------------------------------------------------
// Verification — Ajit
// ---------------------------------------------------------------------------
export const Verification = {
  queue: () => body(api.get('/workflow/verifications')),
  /**
   * 4.4 — what Ajit counts against. Each line carries `expected`, which is the
   * PICKED quantity rather than the ordered one: a short pick is meant to bill
   * short, so counting against the SO would flag every short pick as a mismatch.
   */
  sheet: (orderId) => body(api.get(`/workflow/orders/${orderId}/verifysheet`)),
  /** Every line must be counted — a partial submission is refused. */
  submit: (orderId, lines, signatureId) =>
    body(api.post(`/workflow/orders/${orderId}/verify`, { lines, signature_id: signatureId })),
};

// ---------------------------------------------------------------------------
// Billing — Gaurav
// ---------------------------------------------------------------------------
export const Billing = {
  queue: () => body(api.get('/invoices')),
  get: (id) => body(api.get(`/invoices/${id}`)),
  /** roundOff — 4.5/Billing, capped server-side at ±₹10 regardless of what is sent. */
  raise: (orderId, lines, roundOff) =>
    body(api.post('/invoices', { order_id: orderId, lines, round_off: roundOff })),
  creditNotes: () => body(api.get('/invoices/credit-notes')),
  raiseCreditNote: (payload) => body(api.post('/invoices/credit-notes', payload)),
  issueCreditNote: (id) => body(api.post(`/invoices/credit-notes/${id}/issue`, {})),
  /** 8, "credit note limit" — Yash/Manoj clearing a note above the threshold. */
  approveCreditNote: (id) => body(api.post(`/invoices/credit-notes/${id}/approve`, {})),
  /** 4.5 — Original, Duplicate and Triplicate, as three pages of one PDF. */
  printUrl: (invoiceId) => `${api.defaults.baseURL}/documents/invoice/${invoiceId}.pdf`,

  /**
   * Billing, September 2026 — Sibu's exception-based review queue. Every
   * invoice here has already issued; this is only what still needs a look
   * ("reviewed daily", never a pre-issue gate).
   */
  flagged: (reviewed) => body(api.get('/invoices/flagged', { params: { reviewed } })),
  reviewInvoice: (id) => body(api.post(`/invoices/${id}/review`, {})),
};

// ---------------------------------------------------------------------------
// Dispatch and delivery
// ---------------------------------------------------------------------------
export const Dispatch = {
  sheets: (date) => body(api.get('/dispatch/sheets', { params: { date } })),
  openSheet: (payload) => body(api.post('/dispatch/sheets', payload)),
  addStop: (sheetId, payload) => body(api.post(`/dispatch/sheets/${sheetId}/stops`, payload)),
  release: (sheetId) => body(api.post(`/dispatch/sheets/${sheetId}/release`, {})),
  myRoute: (date) => body(api.get('/dispatch/route', { params: { date } })),
  setActive: (stopId) => body(api.post(`/dispatch/stops/${stopId}/active`, {})),
  deliver: (orderId, payload) => body(api.post(`/dispatch/orders/${orderId}/deliver`, payload)),
  /**
   * 4.4 — "Collection at delivery" (NEW). Cash/cheque collected against the
   * invoice, right there at the stop — a cheque needs `cheque_no` and
   * `photo_id` (the photograph of the cheque itself, mandatory).
   */
  collect: (orderId, payload) => body(api.post(`/dispatch/orders/${orderId}/collect`, payload)),
  fail: (orderId, payload) => body(api.post(`/dispatch/orders/${orderId}/fail`, payload)),

  /** 4.6 — the driver signs their own sheet. Nobody signs on their behalf. */
  sign: (sheetId, signatureId) =>
    body(api.post(`/dispatch/sheets/${sheetId}/sign`, { signature_id: signatureId })),
  /**
   * 4.6 — logging departure is what silences the 10:30 alert, which is why the
   * driver can call it themselves.
   */
  depart: (sheetId) => body(api.post(`/dispatch/sheets/${sheetId}/depart`, {})),
};

// ---------------------------------------------------------------------------
// Purchase — Sonu
// ---------------------------------------------------------------------------
export const Purchases = {
  list: () => body(api.get('/purchases')),
  rateAlerts: () => body(api.get('/purchases/rate-alerts')),
  /** The five forms of section 5, and what each one requires. */
  types: () => body(api.get('/purchases/types')),
  /**
   * R-08: `bill_qty` and `actual_qty` are two separate mandatory fields per
   * line, and the second is never defaulted from the first. R-12: a document
   * photograph is mandatory.
   */
  post: (payload) => body(api.post('/purchases', payload)),
  /** 5.1 — Sonu's physical review, which is what posts the stock. */
  verify: (id, lines) => body(api.post(`/purchases/${id}/verify`, { lines })),
  /** 5.4 — hold the entry for the owner's review. */
  hold: (id, note) => body(api.post(`/purchases/${id}/hold`, { note })),

  /**
   * 5.1 — "beside the line, at entry": last purchase rate/date/supplier plus
   * today's selling rates, so a broken margin is visible before saving.
   */
  itemContext: (itemId) => body(api.get(`/purchases/item-context/${itemId}`)),

  /** 5, "short-supply claims" — auto-raised on entry when bill/actual differ. */
  claims: (status) => body(api.get('/purchases/claims', { params: { status } })),
  decideClaim: (id, status, note) => body(api.post(`/purchases/claims/${id}/decide`, { status, note })),

  /** 5.2 — the weekly price-change report, sorted by rupee impact. */
  priceReport: (from, to) => body(api.get('/purchases/price-report', { params: { from, to } })),
};

// ---------------------------------------------------------------------------
// Returns
// ---------------------------------------------------------------------------
export const Returns = {
  list: (status) => body(api.get('/returns', { params: { status } })),
  get: (id) => body(api.get(`/returns/${id}`)),
  /**
   * Section 6 — step 1 of 3, entry. R-09: the original invoice is mandatory.
   * A reason per line and a photograph are too. Stock does not move and no
   * credit note exists yet — that is steps 2 and 3.
   */
  raise: (payload) => body(api.post('/returns', payload)),
  /**
   * Step 2 — Sonu's (or Hirak's) physical check. `lines` is
   * `[{ return_item_id, good_qty, damaged_qty, damaged_photo_id }]`; this is
   * also the step that moves stock and auto-raises the (pending) credit
   * note R-10's two-hour clock starts against.
   */
  approve: (id, lines) => body(api.post(`/returns/${id}/approve`, { lines })),

  /** 6.1 — the damaged-goods bucket: excluded from sellable stock. */
  damaged: (disposed) => body(api.get('/returns/damaged', { params: { disposed } })),
  disposeDamaged: (id, disposition, note) =>
    body(api.post(`/returns/damaged/${id}/dispose`, { disposition, note })),
};

// ---------------------------------------------------------------------------
// Field sales — Monu
// ---------------------------------------------------------------------------
export const Field = {
  day: (date) => body(api.get('/field/day', { params: { date } })),
  estimates: () => body(api.get('/field/estimates')),
  createEstimate: (payload) => body(api.post('/field/estimates', payload)),
  convertEstimate: (id) => body(api.post(`/field/estimates/${id}/convert`, {})),

  /** Section 7 — three attempts maximum, then convert or close it. */
  estimatesDue: (date) => body(api.get('/field/estimates/due', { params: { date } })),
  followUp: (id, payload) => body(api.post(`/field/estimates/${id}/follow-up`, payload)),
  markLost: (id, reason, note) => body(api.post(`/field/estimates/${id}/lost`, { reason, note })),
  /**
   * Returns the formatted quote and a wa.me link for the salesman to send from
   * their own phone. The server never contacts WhatsApp.
   */
  shareEstimate: (id, phone) => body(api.post(`/field/estimates/${id}/share`, { phone })),
  estimatePdfUrl: (id) => `${api.defaults.baseURL}/documents/estimate/${id}.pdf`,
  beat: (date) => body(api.get('/field/beat', { params: { date } })),
  fileBeat: (payload) => body(api.post('/field/beat', payload)),
  visit: (stopId, payload) => body(api.post(`/field/beat/stops/${stopId}/visit`, payload)),
};

// ---------------------------------------------------------------------------
// Cash, cheques, schemes — Sibu
// ---------------------------------------------------------------------------
export const Cash = {
  cheques: (status) => body(api.get('/cash/cheques', { params: { status } })),
  recordCheque: (payload) => body(api.post('/cash/cheques', payload)),
  setChequeStatus: (id, status) => body(api.post(`/cash/cheques/${id}/status`, { status })),
  eod: (date) => body(api.get('/cash/eod', { params: { date } })),
  closeDay: (payload) => body(api.post('/cash/eod', payload)),
  /** 8 — the second, different-user signature on the same counted figure. */
  confirmDay: (id) => body(api.post(`/cash/eod/${id}/confirm`, {})),
  schemes: () => body(api.get('/cash/schemes')),

  /** Section 11 — Sibu names the KL account and the carrier. */
  handOverCheque: (id, payload) => body(api.post(`/cash/cheques/${id}/hand-over`, payload)),
  /** R-06 — refused without the deposit slip photograph. */
  depositCheque: (id, slipPhotoId) =>
    body(api.post(`/cash/cheques/${id}/deposit`, { deposit_slip_photo_id: slipPhotoId })),

  /** Section 8 — the salesman declares, Sibu counts. Two moments, two rows. */
  handovers: (date) => body(api.get('/cash/handover', { params: { date } })),
  declareHandover: (payload) => body(api.post('/cash/handover', payload)),
  receiveHandover: (id, payload) => body(api.post(`/cash/handover/${id}/receive`, payload)),

  /** 4.8 — Ajit's 7 p.m. godown close. The photograph is mandatory. */
  dayClosings: () => body(api.get('/cash/day-close')),
  closeGodown: (payload) => body(api.post('/cash/day-close', payload)),
};

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------
export const Payments = {
  list: (params) => body(api.get('/payments', { params })),
  outstanding: () => body(api.get('/payments/outstanding')),
  record: (payload) => body(api.post('/payments', payload)),
  reverse: (id, reason) => body(api.post(`/payments/${id}/reverse`, { reason })),
};

// ---------------------------------------------------------------------------
// Stock count
// ---------------------------------------------------------------------------
export const StockCounts = {
  list: () => body(api.get('/stock-counts')),
  get: (id) => body(api.get(`/stock-counts/${id}`)),
  open: (payload) => body(api.post('/stock-counts', payload)),
  saveLines: (id, lines) => body(api.put(`/stock-counts/${id}/lines`, { lines })),
  post: (id) => body(api.post(`/stock-counts/${id}/post`, {})),
};

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------
export const Agents = {
  byPhone: (phone) => body(api.get('/agents', { params: { phone } })),
  list: (q) => body(api.get('/agents', { params: { q } })),
  get: (id) => body(api.get(`/agents/${id}`)),
  create: (payload) => body(api.post('/agents', payload)),
  update: (id, payload) => body(api.put(`/agents/${id}`, payload)),
  commissions: (id) => body(api.get(`/agents/${id}/commissions`)),
  bookCommission: (id, payload) => body(api.post(`/agents/${id}/commissions`, payload)),
};

// ---------------------------------------------------------------------------
// Masters
// ---------------------------------------------------------------------------
export const Items = {
  /**
   * Bounded at 200 by default. R-07: an account without `items.rates` receives
   * no rate columns at all — they are absent from the payload, not hidden.
   */
  list: (params) => body(api.get('/items', { params })),
  get: (id) => body(api.get(`/items/${id}`)),
  create: (payload) => body(api.post('/items', payload)),
  /**
   * All six customer-type rates for one item, with nulls where a type has no
   * rate and a sentence saying why.
   */
  rates: (id) => body(api.get(`/items/${id}/rates`)),
  /**
   * R-04 and R-11. A rate field sent by the rate keeper comes back **202 with
   * RATE_CHANGE_PENDING** and changes nothing until an owner approves it; an
   * owner's own edit applies at once. Non-rate fields save immediately.
   */
  update: (id, payload) => body(api.put(`/items/${id}`, payload)),
  /** A correction is a new signed movement, never an edit to an existing one. */
  adjustStock: (id, payload) => body(api.post(`/items/${id}/stock`, payload)),
  rateChanges: (status) => body(api.get('/items/rate-changes', { params: { status } })),
  decideRateChange: (batchRef, approve, note) =>
    body(api.post(`/items/rate-changes/${batchRef}/decide`, { approve, note })),
  /**
   * Add-only, never update. "Compare with what's already there — add what's
   * missing, leave the rest." Yash or Manoj only; the route re-checks.
   */
  import: ({ base64, filename }) =>
    body(api.post('/items/import', { data: base64, filename })),
};

export const Customers = {
  list: (params) => body(api.get('/customers', { params })),
  get: (id) => body(api.get(`/customers/${id}`)),
  /**
   * `customer_type` decides which of an item's six rates the party is billed
   * at, so it is nullable and never defaulted — POST /orders refuses an
   * unclassified party rather than guessing.
   */
  create: (payload) => body(api.post('/customers', payload)),
  update: (id, payload) => body(api.put(`/customers/${id}`, payload)),
  /**
   * The Party Information Card (3.3) — credit limit, used, free, last order
   * date, outstanding and the age of the oldest bill. Fetched before an order
   * is punched so a blocked party is obvious before the salesman fills in a
   * whole order, not only inside the 409 the punch itself would return.
   */
  creditStatus: (id) => body(api.get(`/customers/${id}/credit-status`)),
};

export const Users = {
  // `/users/employees`, not `/users` — the router has no index route, and the
  // bare path fell through to the 404 handler.
  list: () => body(api.get('/users/employees')),
  create: (payload) => body(api.post('/users', payload)),
  update: (id, payload) => body(api.put(`/users/${id}`, payload)),
  setPermissions: (id, permissions) => body(api.patch(`/users/${id}/permissions`, { permissions })),
  /**
   * Offboarding is a status change, never a delete: `checkins` and
   * `location_logs` cascade from `users`, so removing somebody destroys every
   * attendance record and GPS ping the company holds for them.
   */
  setActive: (id, isActive) => body(api.patch(`/users/${id}/status`, { is_active: isActive })),
  remove: (id) => body(api.delete(`/users/${id}`)),

  /**
   * A voluntary password change (migration 016). Not R-24..R-30 — a business
   * decision that only Yash or Manoj may put a new password into effect. The
   * mandatory first-change gate (`Auth` — `/auth/change-password`, driven by
   * `must_change_password`) is a different, immediate path and does not go
   * through this queue.
   */
  requestPasswordChange: (currentPassword, newPassword) =>
    body(api.post('/users/password-requests', {
      current_password: currentPassword, new_password: newPassword,
    })),
  passwordRequests: (status) =>
    body(api.get('/users/password-requests', { params: { status } })),
  decidePasswordRequest: (id, approve, note) =>
    body(api.post(`/users/password-requests/${id}/decide`, { approve, note })),
};

// ---------------------------------------------------------------------------
// Live tracking (D.1)
// ---------------------------------------------------------------------------
/**
 * These read the GPS trail of identified people and take `live_tracking.view`.
 * The trail was readable without any grant until August 2026; it is not now.
 */
export const Tracking = {
  live: () => body(api.get('/location/live')),
  history: (userId, date) => body(api.get(`/location/user/${userId}/history`, { params: { date } })),
  checkinFix: (userId, date) => body(api.get(`/location/user/${userId}/checkin`, { params: { date } })),
};

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
export const Dashboard = {
  /**
   * Ungated beyond authenticate, and scoped to the caller unless they hold the
   * `orders` AREA grant — the same grant that widens the order list, so one
   * account gets one consistent scope rather than two.
   */
  today: (params) => body(api.get('/reports/dashboard', { params })),
};

// ---------------------------------------------------------------------------
// Attendance — the caller's own shift (section 6, C.2, C.3)
// ---------------------------------------------------------------------------
/**
 * R-24: no photograph, no check-in. The photo is uploaded through
 * `Attachments.upload` first and its id passed here; an id uploaded by somebody
 * else is refused, which is the substitution the rule exists to prevent.
 */
export const Attendance = {
  today: () => body(api.get('/attendance/today')),
  checkIn: ({ latitude, longitude, photoId }) =>
    body(api.post('/attendance/checkin', { latitude, longitude, photo_id: photoId })),
  checkOut: ({ latitude, longitude, photoId }) =>
    body(api.post('/attendance/checkout', { latitude, longitude, photo_id: photoId })),
  lunchOut: (fix) => body(api.post('/attendance/lunch-out', fix)),
  lunchIn: (fix) => body(api.post('/attendance/lunch-in', fix)),

  // Everything below reads other people's records and takes an attendance grant.
  daily: (date) => body(api.get('/attendance/daily', { params: { date } })),
  monthlySummary: (params) => body(api.get('/attendance/monthly-summary', { params })),
  employeeMonth: (id, params) => body(api.get(`/attendance/employee/${id}/monthly`, { params })),
  holidays: () => body(api.get('/attendance/holidays')),
  addHoliday: (payload) => body(api.post('/attendance/holidays', payload)),
  removeHoliday: (id) => body(api.delete(`/attendance/holidays/${id}`)),
};

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------
export const Alerts = {
  list: (params) => body(api.get('/notifications', { params })),
  markRead: (id) => body(api.post(`/notifications/${id}/read`, {})),
  markAllRead: () => body(api.post('/notifications/read-all', {})),
};

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------
export const Attachments = {
  /**
   * Uploads a captured photo and returns the reference a delivery stores.
   *
   * The image is sent as base64 in JSON because that is what expo-image-picker
   * already hands back, and the API takes no other content type. The caller
   * passes the picker's asset straight through.
   */
  upload: ({ base64, mimeType = 'image/jpeg', name, refType, refId }) =>
    body(
      api.post('/attachments', {
        data: base64,
        mime_type: mimeType,
        original_name: name,
        ref_type: refType,
        ref_id: refId,
      })
    ),

  /** The URL a captured photo is displayed from. Requires the auth header. */
  url: (photoRef) => `${api.defaults.baseURL}/attachments/${photoRef}`,
};

// ---------------------------------------------------------------------------
// Payroll — salary, advances, leave (addendum A, B, C.6)
// ---------------------------------------------------------------------------
/**
 * Two access shapes run through this whole group, and they are deliberately
 * different: `salary.manage` acts on everybody, and an employee with no grant
 * at all reads their own. Every call below that takes an employee id works for
 * the caller's own without any permission.
 */
export const Payroll = {
  // Salary
  salary: (employeeId, period) => body(api.get(`/payroll/salary/${employeeId}/${period}`)),
  finalise: (employeeId, period) =>
    body(api.post(`/payroll/salary/${employeeId}/${period}/finalise`, {})),
  approveSalary: (periodId) => body(api.post(`/payroll/salary/${periodId}/approve`, {})),
  paySalary: (periodId, paidOn) => body(api.post(`/payroll/salary/${periodId}/pay`, { paid_on: paidOn })),
  register: (period) => body(api.get(`/payroll/register/${period}`)),
  attendanceSummary: (employeeId, period) =>
    body(api.get(`/payroll/attendance-summary/${employeeId}/${period}`)),

  // R-28 — a waiver needs a reason, and the line stays on the slip.
  waive: (deductionId, reason) =>
    body(api.post(`/payroll/deductions/${deductionId}/waive`, { reason })),

  // A.2 — the slip. Only a finalised month has one.
  slip: (employeeId, period) => body(api.get(`/payroll/slip/${employeeId}/${period}`)),
  shareSlip: (periodId) => body(api.post(`/payroll/slip/${periodId}/share`, {})),
  slipPdfUrl: (employeeId, period) =>
    `${api.defaults.baseURL}/documents/salary-slip/${employeeId}/${period}.pdf`,

  // Advances — B
  advances: (scope) => body(api.get('/payroll/advances', { params: { scope } })),
  requestAdvance: (payload) => body(api.post('/payroll/advances', payload)),
  decideAdvance: (id, approve, startsMonth) =>
    body(api.post(`/payroll/advances/${id}/decide`, { approve, starts_month: startsMonth })),

  // Leave — C.6
  leave: (params) => body(api.get('/payroll/leave', { params })),
  applyLeave: (payload) => body(api.post('/payroll/leave', payload)),
  decideLeave: (id, approve, note) =>
    body(api.post(`/payroll/leave/${id}/decide`, { approve, note })),
};

// ---------------------------------------------------------------------------
// Incentives — the 20 segments (section 9)
// ---------------------------------------------------------------------------
export const Incentives = {
  segments: () => body(api.get('/incentives/segments')),
  /** Live progress. Recomputed on every read while the period is a draft. */
  progress: (employeeId, period) => body(api.get(`/incentives/${employeeId}/${period}`)),
  compute: (employeeId, period) => body(api.post(`/incentives/${employeeId}/${period}/compute`, {})),
  approve: (periodId) => body(api.post(`/incentives/${periodId}/approve`, {})),
  pay: (periodId, paidOn) => body(api.post(`/incentives/${periodId}/pay`, { paid_on: paidOn })),
  register: (period) => body(api.get(`/incentives/register/${period}`)),
};

// ---------------------------------------------------------------------------
// Goods in Transit, suppliers, transporters (section 5.2, 5.3)
// ---------------------------------------------------------------------------
export const Git = {
  register: (params) => body(api.get('/git', { params })),
  record: (payload) => body(api.post('/git', payload)),
  stage: (id, to, note) => body(api.post(`/git/${id}/stage`, { to, note })),
  gstPending: () => body(api.get('/git/gst-pending')),
  /** 5.3 — the GST bill arrives and converts the unregistered purchase. */
  gstBill: (purchaseId, billNo) => body(api.post(`/git/gst-bill/${purchaseId}`, { bill_no: billNo })),

  suppliers: (q) => body(api.get('/git/suppliers', { params: { q } })),
  createSupplier: (payload) => body(api.post('/git/suppliers', payload)),
  transporters: () => body(api.get('/git/transporters')),
  createTransporter: (payload) => body(api.post('/git/transporters', payload)),
};

// ---------------------------------------------------------------------------
// Internal transfers (R-14)
// ---------------------------------------------------------------------------
export const Transfers = {
  list: (params) => body(api.get('/transfers', { params })),
  get: (id) => body(api.get(`/transfers/${id}`)),
  send: (payload) => body(api.post('/transfers', payload)),
  /** The received quantity is its own field — never defaulted from what was sent. */
  receive: (id, lines) => body(api.post(`/transfers/${id}/receive`, { lines })),
  journal: (id) => body(api.post(`/transfers/${id}/journal`, {})),
};

// ---------------------------------------------------------------------------
// Schemes — KL Utsav (3.2) and the Lemac growth regime
// ---------------------------------------------------------------------------
export const Schemes = {
  list: () => body(api.get('/schemes')),
  standings: () => body(api.get('/schemes/standings')),

  // KL Utsav membership. `member` answers `{ member: null }` for an unknown
  // number rather than a 404 — not being registered is the ordinary case.
  member: (phone) => body(api.get('/schemes/members', { params: { phone } })),
  members: () => body(api.get('/schemes/members')),
  register: (payload) => body(api.post('/schemes/members', payload)),
  memberStanding: (id) => body(api.get(`/schemes/members/${id}`)),

  // The Lemac dealer growth schemes. Seeded INACTIVE — activating one starts
  // accruing money against every dealer invoice.
  growth: () => body(api.get('/schemes/growth')),
  growthStanding: (customerId) => body(api.get(`/schemes/growth/standing/${customerId}`)),
  growthLeaderboard: (schemeId) => body(api.get(`/schemes/growth/${schemeId}/standings`)),
  issueAward: (awardId) => body(api.post(`/schemes/growth/awards/${awardId}/issue`, {})),

  /** The Lemac sheet: "App should allow validity dates to be updated each cycle." */
  updateCycle: (id, payload) => body(api.put(`/schemes/${id}`, payload)),
  activate: (id, active) => body(api.post(`/schemes/${id}/activate`, { active })),
};

// ---------------------------------------------------------------------------
// Reports — section 12
// ---------------------------------------------------------------------------
/**
 * Every report takes `from` and `to`, both defaulting to today, and supports
 * `format=csv` and `format=pdf`.
 *
 * The two export helpers return a URL rather than fetching: a download is the
 * browser's job, and pulling a 5,000-row PDF through axios into memory to hand
 * it back to a link is work for nothing.
 */
export const Reports = {
  catalogue: () => body(api.get('/reportsuite')),

  dailySales: (params) => body(api.get('/reportsuite/daily-sales', { params })),
  outstanding: (params) => body(api.get('/reportsuite/outstanding', { params })),
  /** 8 — bill-wise, never party totals only. The seven cash-discount-aligned buckets. */
  outstandingBills: (params) => body(api.get('/reportsuite/outstanding-bills', { params })),
  salesmanPerformance: (params) => body(api.get('/reportsuite/salesman-performance', { params })),
  incentiveProgress: (period) => body(api.get(`/reportsuite/incentive-progress/${period}`)),
  purchases: (params) => body(api.get('/reportsuite/purchases', { params })),
  stock: (params) => body(api.get('/reportsuite/stock', { params })),
  cheques: (params) => body(api.get('/reportsuite/cheques', { params })),
  cashDiscount: (params) => body(api.get('/reportsuite/cash-discount', { params })),
  estimateConversion: (params) => body(api.get('/reportsuite/estimate-conversion', { params })),
  party: (customerId) => body(api.get(`/reportsuite/party/${customerId}`)),
  stockCounts: (params) => body(api.get('/reportsuite/stock-counts', { params })),

  /** Section 12's "Mark Reviewed", and its history. */
  markReviewed: (note) => body(api.post('/reportsuite/reviewed', { note })),
  reviews: () => body(api.get('/reportsuite/reviewed')),

  exportUrl: (key, params = {}, format = 'csv') => {
    const query = new URLSearchParams({ ...params, format }).toString();
    return `${api.defaults.baseURL}/reportsuite/${key}?${query}`;
  },
};

// ---------------------------------------------------------------------------
// Printed documents (4.5, 7, A.2)
// ---------------------------------------------------------------------------
/**
 * URLs, not fetches. These open in a viewer or a print dialogue; the auth
 * header rides on the request the browser makes because the API and the app
 * share an origin in the web build. On native, open them through the
 * authenticated client.
 */
export const Documents = {
  /** 4.5 — Original, Duplicate and Triplicate, as three pages of one PDF. */
  invoiceUrl: (invoiceId) => `${api.defaults.baseURL}/documents/invoice/${invoiceId}.pdf`,
  estimateUrl: (estimateId) => `${api.defaults.baseURL}/documents/estimate/${estimateId}.pdf`,
  salarySlipUrl: (employeeId, period) =>
    `${api.defaults.baseURL}/documents/salary-slip/${employeeId}/${period}.pdf`,
};

// ---------------------------------------------------------------------------
// Tally Prime (section 14)
// ---------------------------------------------------------------------------
export const Tally = {
  /** Is it working, and what is stuck? The first question anyone asks. */
  status: () => body(api.get('/tally/status')),
  /** The preflight. Run before enabling the sync on the office machine. */
  doctor: () => body(api.get('/tally/doctor')),
  queue: (params) => body(api.get('/tally/queue', { params })),
  payloadUrl: (id) => `${api.defaults.baseURL}/tally/queue/${id}/payload`,
  retry: (id) => body(api.post(`/tally/queue/${id}/retry`, {})),
  retryAll: () => body(api.post('/tally/queue/retry-all', {})),
  push: () => body(api.post('/tally/push', {})),
  pull: (scope) => body(api.post('/tally/pull', { scope })),
  /** Where the two systems disagree. Neither figure is overwritten. */
  reconciliation: (params) => body(api.get('/tally/reconciliation', { params })),
  resolve: (id, resolution) =>
    body(api.post(`/tally/reconciliation/${id}/resolve`, { resolution })),
};
