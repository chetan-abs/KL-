import React from 'react';
import { StyleSheet } from 'react-native';

import { SHIFTS } from '../../constants/options';
import { Users } from '../../services/endpoints';
import { useAction } from '../../hooks/useApi';
import { checkPassword } from '../../utils/password';
import { showAlert } from '../../services/confirm';
import Screen from '../../components/mobile/Screen';
import ScreenHeader from '../../components/mobile/ScreenHeader';
import Card from '../../components/mobile/Card';
import Field from '../../components/mobile/Field';
import Select from '../../components/mobile/Select';
import ActionButton from '../../components/mobile/ActionButton';
import NoticeBar from '../../components/mobile/NoticeBar';

const ROLE_OPTIONS = [
  { value: 'employee', label: 'Staff' },
  { value: 'admin', label: 'Super Admin (Owner)' },
];

/**
 * Employee onboarding, for Yash or Manoj. `employees.create` opens the screen;
 * the fixed salary field only does anything because `POST /users` re-checks
 * `employees.permissions` itself (A.1: "editable only by Yash or Manoj") — a
 * lesser account reaching this screen some other way still cannot set one.
 *
 * Grants are deliberately not asked here. `PeopleScreen` already owns that
 * form field by field against the live permission list, and a second copy of
 * it on this screen would be a second place for the two to drift apart. A new
 * account starts with none and is granted from there, the same day.
 */
export default function NewEmployeeScreen({ role, onBack, onSaved, nav }) {
  const [id, setId] = React.useState('');
  const [name, setName] = React.useState('');
  const [phone, setPhone] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [empRole, setEmpRole] = React.useState('employee');
  const [shift, setShift] = React.useState('A');
  const [salary, setSalary] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [errors, setErrors] = React.useState({});

  const create = useAction(
    () =>
      Users.create({
        id: id.trim().toLowerCase(),
        name: name.trim(),
        phone: phone.trim() || null,
        email: email.trim() || null,
        role: empRole,
        shift_code: shift,
        fixed_salary: Number(salary) || 0,
        password,
      }),
    {
      onDone: () => {
        showAlert(
          'Employee created',
          `${name.trim()} can sign in with the password you set, and must choose their own on first use.`
        );
        onSaved?.();
      },
      onFail: (message) => showAlert('Could not create', message),
    }
  );

  function save() {
    const next = {};
    if (!id.trim()) next.id = 'The username they sign in with.';
    else if (!/^[a-z0-9._-]+$/i.test(id.trim())) next.id = 'Letters, numbers, dots, dashes only.';
    if (!name.trim()) next.name = 'Their full name.';
    const passwordError = checkPassword(password);
    if (passwordError) next.password = passwordError;

    setErrors(next);
    if (Object.keys(next).length) return;
    create.run();
  }

  return (
    <Screen
      nav={nav}
      header={
        <ScreenHeader
          role={role.name}
          title="New Employee"
          subtitle="Section 2 — add a staff account"
          onBack={onBack}
          backLabel="People"
          badge="New"
          badgeTone="info"
        />
      }
      footer={
        <ActionButton
          label="Create Employee"
          tone="teal"
          loading={create.busy}
          loadingLabel="Creating"
          onPress={save}
        />
      }
    >
      <Card title="Account">
        <Field
          label="Username"
          required
          value={id}
          onChangeText={setId}
          placeholder="e.g. rajesh"
          autoCapitalize="none"
          autoCorrect={false}
          error={errors.id}
        />
        <Field
          label="Full name"
          required
          style={styles.spaced}
          value={name}
          onChangeText={setName}
          placeholder="e.g. Rajesh Deka"
          error={errors.name}
        />
        <Field
          label="Phone"
          style={styles.spaced}
          value={phone}
          onChangeText={setPhone}
          keyboardType="phone-pad"
        />
        <Field
          label="Email"
          style={styles.spaced}
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          autoCapitalize="none"
        />
        <Field
          label="Temporary password"
          required
          style={styles.spaced}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          error={errors.password}
          hint="They must change it the first time they sign in."
        />
      </Card>

      <Card title="Work">
        <Select label="Role" value={empRole} options={ROLE_OPTIONS} onChange={setEmpRole} />
        <Select
          label="Shift"
          style={styles.spaced}
          value={shift}
          options={SHIFTS.map((s) => ({ value: s.value, label: `${s.label} — ${s.caption}` }))}
          onChange={setShift}
        />
        <Field
          label="Fixed monthly salary (₹)"
          style={styles.spaced}
          value={salary}
          onChangeText={setSalary}
          keyboardType="numeric"
          placeholder="0"
          hint="A.1 — starts at ₹0 until entered; only Yash or Manoj can set it."
        />
      </Card>

      <NoticeBar tone="info">
        No permissions are granted yet. Open the new account from People once created to give it
        the screens it needs.
      </NoticeBar>
    </Screen>
  );
}

const styles = StyleSheet.create({
  spaced: { marginTop: 13 },
});
