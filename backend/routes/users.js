const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { authenticate, requirePermission, USER_FIELDS } = require('../middleware/auth');
const { userCan } = require('../utils/permissions');
const { checkPassword } = require('../utils/password');
const { notify, usersWhoCan } = require('../utils/workflow');

const router = express.Router();
router.use(authenticate);

// Guards are per action rather than per router so the four grants the employee
// form hands out actually differ. A router-level requirePermission('employees')
// would have made 'employees.view' useless: an area grant satisfies an action
// check, never the reverse, so a view-only account would have been refused at
// the door on every route including the list it was granted.
//
// Writing someone else's permissions is deliberately not covered by
// 'employees.edit'. It is its own grant, which only ["all"] (or an explicit
// 'employees' area grant) satisfies — otherwise anyone allowed to correct a
// phone number could grant themselves everything and escalate to admin.
const PERMISSION_GRANT = 'employees.permissions';

// `role` is guarded by the same grant, for the same reason. userCan() does not
// consult role, but the client does: the live map filters on role = 'employee',
// and every admin created so far carries ["all"]. Leaving role under
// 'employees.edit' meant anyone who could fix a typo could promote themselves.
function mayWriteRole(user) {
  return userCan(user, PERMISSION_GRANT);
}

router.get('/employees', requirePermission('employees.view'), async (req, res) => {
  const [rows] = await pool.query(
    `SELECT ${USER_FIELDS} FROM users ORDER BY is_active DESC, name ASC`
  );
  res.json({ employees: rows });
});

router.patch('/:id/status', requirePermission('employees.edit'), async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'You cannot deactivate your own account' });
  if (typeof req.body?.is_active !== 'boolean') return res.status(400).json({ error: 'Active status is required' });
  const [result] = await pool.query('UPDATE users SET is_active = ? WHERE id = ?', [req.body.is_active, req.params.id]);
  if (!result.affectedRows) return res.status(404).json({ error: 'Employee not found' });
  res.json({ id: req.params.id, is_active: req.body.is_active });
});

router.patch('/:id/permissions', requirePermission(PERMISSION_GRANT), async (req, res) => {
  const permissions = req.body?.permissions;
  if (!Array.isArray(permissions) || permissions.some((p) => typeof p !== 'string')) return res.status(400).json({ error: 'Permissions must be a list' });
  const [result] = await pool.query('UPDATE users SET permissions = ? WHERE id = ?', [JSON.stringify([...new Set(permissions)]), req.params.id]);
  if (!result.affectedRows) return res.status(404).json({ error: 'Employee not found' });
  res.json({ id: req.params.id, permissions });
});

router.post('/', requirePermission('employees.create'), async (req, res) => {
  const {
    id, name, email, phone, address, city, state, role = 'employee', title, password, permissions = [],
    shift_code, fixed_salary, geofenced,
  } = req.body || {};
  if (!id?.trim() || !name?.trim()) {
    return res.status(400).json({ error: 'Employee ID and name are required' });
  }
  if (!['admin', 'employee'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (shift_code !== undefined && shift_code !== null && !['A', 'B'].includes(shift_code)) {
    return res.status(400).json({ error: 'Invalid shift' });
  }

  // The client used to substitute 'password123' when the field was left blank,
  // so a blank field produced a working account with a password published in
  // the source. There is no default: an account is created with a password the
  // creator chose, or it is not created.
  const passwordError = checkPassword(password);
  if (passwordError) return res.status(400).json({ error: passwordError });

  if (role === 'admin' && !mayWriteRole(req.user)) {
    return res.status(403).json({ error: 'Permission denied', required: PERMISSION_GRANT });
  }
  // Same escalation route as PATCH /:id/permissions, one step removed: without
  // this a creator could mint an account holding ["all"] and sign in as it.
  const grants = Array.isArray(permissions) ? permissions : [];
  if (grants.length && !userCan(req.user, PERMISSION_GRANT)) {
    return res.status(403).json({ error: 'Permission denied', required: PERMISSION_GRANT });
  }
  // A.1 — "The salary amount is editable only by Yash or Manoj." Reusing the
  // same grant PATCH /:id/permissions requires, because that is who this
  // account's own grants say Yash and Manoj are, rather than a second list to
  // keep in step with the first.
  if (fixed_salary !== undefined && !mayWriteRole(req.user)) {
    return res.status(403).json({ error: 'Permission denied', required: PERMISSION_GRANT });
  }
  const hash = await bcrypt.hash(password, 10);
  try {
    await pool.query(
      `INSERT INTO users (id, name, email, phone, address, city, state, role, password, permissions,
                          shift_code, fixed_salary, geofenced, created_by, must_change_password)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE)`,
      // must_change_password: whoever creates an account types the first
      // password, so two people know it before it has ever been used. That is
      // the same condition a seeded account is in (migration 015), and it gets
      // the same treatment — the new employee can sign in, and the first thing
      // they can do is choose their own.
      [id.trim(), name.trim(), email?.trim() || null, phone?.trim() || null, address?.trim() || null, city?.trim() || null, state?.trim() || null, role, hash, JSON.stringify([...new Set(grants)]),
        shift_code || null, Number(fixed_salary) || 0, geofenced === undefined ? true : Boolean(geofenced), req.user.id]
    );
    const [[employee]] = await pool.query(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`, [id.trim()]);
    res.status(201).json({ employee });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Employee ID or email already exists' });
    throw error;
  }
});

router.put('/:id', requirePermission('employees.edit'), async (req, res) => {
  const {
    name, email, phone, address, city, state, role, password, permissions,
    shift_code, fixed_salary, geofenced,
  } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });
  if (Array.isArray(permissions) && !userCan(req.user, PERMISSION_GRANT)) {
    return res.status(403).json({ error: 'Permission denied', required: PERMISSION_GRANT });
  }
  if (shift_code !== undefined && shift_code !== null && !['A', 'B'].includes(shift_code)) {
    return res.status(400).json({ error: 'Invalid shift' });
  }
  // A.1 — "The salary amount is editable only by Yash or Manoj. No other role
  // can modify it." The same grant PATCH /:id/permissions requires, so there
  // is one list of who Yash and Manoj are rather than two to keep in step.
  if (fixed_salary !== undefined && !mayWriteRole(req.user)) {
    return res.status(403).json({ error: 'Permission denied', required: PERMISSION_GRANT });
  }

  const [[existing]] = await pool.query('SELECT id, role FROM users WHERE id = ?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Employee not found' });

  // The form used to post role: 'employee' unconditionally, so saving an edit
  // to an administrator's phone number demoted them. An omitted role now means
  // "leave it alone", and changing one takes the permissions grant.
  let nextRole = existing.role;
  if (role !== undefined && role !== existing.role) {
    if (!['admin', 'employee'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    if (!mayWriteRole(req.user)) {
      return res.status(403).json({ error: 'Permission denied', required: PERMISSION_GRANT });
    }
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: 'You cannot change your own role' });
    }
    nextRole = role;
  }

  const values = [name.trim(), email?.trim() || null, phone?.trim() || null, address?.trim() || null, city?.trim() || null, state?.trim() || null, nextRole];
  let passwordSql = '', permissionsSql = '';
  if (password) {
    const passwordError = checkPassword(password);
    if (passwordError) return res.status(400).json({ error: passwordError });
    // An administrator resetting somebody's password is the locked-out case:
    // they have typed a value and are about to read it out. It is temporary by
    // definition, so it is flagged the same way a created account is, and the
    // owner replaces it before the account does anything else.
    passwordSql = ', password = ?, must_change_password = TRUE';
    values.push(await bcrypt.hash(password, 10));
  }
  if (Array.isArray(permissions)) { permissionsSql = ', permissions = ?'; values.push(JSON.stringify([...new Set(permissions)])); }

  let shiftSql = '', salarySql = '', geofencedSql = '';
  if (shift_code !== undefined) { shiftSql = ', shift_code = ?'; values.push(shift_code || null); }
  if (fixed_salary !== undefined) { salarySql = ', fixed_salary = ?'; values.push(Number(fixed_salary) || 0); }
  if (geofenced !== undefined) { geofencedSql = ', geofenced = ?'; values.push(Boolean(geofenced)); }

  values.push(req.params.id);
  try {
    const [result] = await pool.query(
      `UPDATE users SET name = ?, email = ?, phone = ?, address = ?, city = ?, state = ?, role = ?${passwordSql}${permissionsSql}${shiftSql}${salarySql}${geofencedSql} WHERE id = ?`, values
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'Employee not found' });
    const [[employee]] = await pool.query(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`, [req.params.id]);
    res.json({ employee });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Email already exists' });
    throw error;
  }
});

// There is deliberately no bulk-delete route.
//
// `DELETE /employees/all` used to run `DELETE FROM users WHERE role = "employee"`
// behind a single client-side confirm — which on web was a no-op dialog, so the
// button fired without asking. checkins and location_logs cascade from users, so
// that one request destroyed every attendance record and every GPS ping ever
// collected, irreversibly, for data that may be needed to settle a payroll
// dispute. Offboarding is PATCH /:id/status (is_active = false), which is
// honoured on every request and can be undone.

router.delete('/:id', requirePermission('employees.delete'), async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });
  const [result] = await pool.query('DELETE FROM users WHERE id = ?', [req.params.id]);
  if (!result.affectedRows) return res.status(404).json({ error: 'Employee not found' });
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Voluntary password changes — approved by Yash or Manoj (migration 016)
// ---------------------------------------------------------------------------
//
// Business decision, not in the requirements PDF: a staff member cannot put a
// new password into effect on their own. They submit one; it takes effect
// only once an owner decides it. The MANDATORY first-change gate (migration
// 015, PATCH /auth/change-password) stays exactly as it was — this is a
// second, separate path for a voluntary change from an account already past
// that gate. Routing the mandatory gate through an approval queue would lock
// a new account out of the app until somebody happened to be free to approve
// it, which is the exact failure that gate exists to prevent.

/** POST /api/users/password-requests — an employee proposes a new password. */
router.post('/password-requests', async (req, res, next) => {
  try {
    const { current_password, new_password } = req.body || {};
    const policyError = checkPassword(new_password);
    if (!current_password || policyError) {
      return res.status(400).json({ error: policyError || 'Your current password is required' });
    }
    if (current_password === new_password) {
      return res.status(400).json({ error: 'The new password must be different from the current one' });
    }

    // Same identity check `PATCH /auth/change-password` makes. An approval
    // queue downstream is not a reason to skip it — a stolen session token
    // should not be able to queue a password an owner might approve without
    // ever thinking to ask the employee whether they actually requested it.
    const [[account]] = await pool.query('SELECT password FROM users WHERE id = ?', [req.user.id]);
    if (!account || !(await bcrypt.compare(current_password, account.password))) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    const [[pending]] = await pool.query(
      "SELECT id FROM password_change_requests WHERE employee_id = ? AND status = 'pending'",
      [req.user.id]
    );
    if (pending) {
      return res.status(409).json({
        error: 'A password change is already waiting on approval. Ask Yash or Manoj to decide it first.',
        code: 'ALREADY_PENDING',
      });
    }

    const hash = await bcrypt.hash(new_password, 10);
    const [result] = await pool.query(
      'INSERT INTO password_change_requests (employee_id, new_password) VALUES (?, ?)',
      [req.user.id, hash]
    );

    for (const owner of await usersWhoCan(pool, 'all')) {
      await notify(pool, {
        userId: owner,
        tone: 'info',
        title: 'Password change requested',
        body: `${req.user.name} wants to change their password.`,
        actor: req.user.id,
        refType: 'password_request',
        refId: result.insertId,
      });
    }

    res.status(201).json({ message: 'Sent for approval.', id: result.insertId });
  } catch (err) { next(err); }
});

/** GET /api/users/password-requests — the approval queue. Yash / Manoj only. */
router.get('/password-requests', requirePermission(PERMISSION_GRANT), async (req, res, next) => {
  try {
    const status = ['pending', 'approved', 'rejected'].includes(req.query.status)
      ? req.query.status : 'pending';

    const [rows] = await pool.query(
      `SELECT r.id, r.employee_id, u.name AS employee_name, r.status,
              r.requested_at, r.decided_by, d.name AS decided_by_name, r.decided_at, r.decision_note
         FROM password_change_requests r
         JOIN users u ON u.id = r.employee_id
         LEFT JOIN users d ON d.id = r.decided_by
        WHERE r.status = ?
        ORDER BY r.requested_at DESC
        LIMIT 200`, [status]
    );
    res.json({ status, requests: rows });
  } catch (err) { next(err); }
});

/** POST /api/users/password-requests/:id/decide — Yash / Manoj only. */
router.post('/password-requests/:id/decide', requirePermission(PERMISSION_GRANT), async (req, res, next) => {
  const approve = req.body?.approve === true || req.body?.approve === 'true';
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[request]] = await conn.query(
      "SELECT * FROM password_change_requests WHERE id = ? AND status = 'pending' FOR UPDATE",
      [req.params.id]
    );
    if (!request) {
      await conn.rollback();
      return res.status(404).json({ error: 'No pending request with that id.' });
    }

    if (approve) {
      await conn.query(
        `UPDATE users SET password = ?, must_change_password = FALSE, password_changed_at = UTC_TIMESTAMP()
          WHERE id = ?`,
        [request.new_password, request.employee_id]
      );
    }

    await conn.query(
      `UPDATE password_change_requests
          SET status = ?, decided_by = ?, decided_at = NOW(), decision_note = ?
        WHERE id = ?`,
      [approve ? 'approved' : 'rejected', req.user.id, req.body?.note || null, request.id]
    );

    await notify(conn, {
      userId: request.employee_id,
      tone: approve ? 'success' : 'warning',
      title: approve ? 'Password change approved' : 'Password change declined',
      body: approve
        ? 'Your new password is now active. Sign in with it next time.'
        : (req.body?.note || 'Ask Yash or Manoj why, and submit again if needed.'),
      actor: req.user.id,
      refType: 'password_request',
      refId: request.id,
    });

    await conn.commit();
    res.json({ message: approve ? 'Password change approved.' : 'Password change declined.' });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

module.exports = router;
