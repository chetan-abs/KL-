import React from 'react';
import { StyleSheet } from 'react-native';

import { checkPassword } from '../../utils/password';
import { Users } from '../../services/endpoints';
import { useAction } from '../../hooks/useApi';
import { showAlert } from '../../services/confirm';
import Screen from '../../components/mobile/Screen';
import ScreenHeader from '../../components/mobile/ScreenHeader';
import Card from '../../components/mobile/Card';
import Field from '../../components/mobile/Field';
import ActionButton from '../../components/mobile/ActionButton';
import NoticeBar from '../../components/mobile/NoticeBar';

/**
 * A voluntary password change — business decision, not in the requirements
 * PDF. Submitting here does not change anything by itself: it sits waiting
 * for Yash or Manoj to approve it, the same shape R-11 uses for a rate.
 *
 * Distinct from `ForcePasswordScreen`, the mandatory gate a seeded password
 * lands on — that one takes effect immediately, because an account stuck
 * behind an approval it cannot reach anybody to grant would be locked out of
 * the app entirely. This screen is for an account already past that gate,
 * choosing to change a password nothing is forcing it to change.
 */
export default function ChangePasswordScreen({ role, onBack, nav }) {
  const nextRef = React.useRef(null);
  const confirmRef = React.useRef(null);

  const [current, setCurrent] = React.useState('');
  const [next, setNext] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [error, setError] = React.useState(null);
  const [sent, setSent] = React.useState(false);

  const policyComplaint = next ? checkPassword(next) : null;

  const submit = useAction(
    () => Users.requestPasswordChange(current, next),
    {
      onDone: () => setSent(true),
      onFail: (message) => setError(message),
    }
  );

  function save() {
    if (!current) return setError('Enter your current password.');
    if (policyComplaint) return setError(policyComplaint);
    if (next !== confirm) return setError('The two new passwords do not match.');
    if (next === current) return setError('The new password must be different.');
    setError(null);
    submit.run();
  }

  if (sent) {
    return (
      <Screen
        nav={nav}
        header={<ScreenHeader role={role.name} title="Change Password" onBack={onBack} />}
      >
        <NoticeBar tone="success" glyph="✓">
          Sent. Your password stays as it is until Yash or Manoj approves the change — you'll be
          notified either way.
        </NoticeBar>
        <ActionButton label="Done" tone="neutral" onPress={onBack} />
      </Screen>
    );
  }

  return (
    <Screen
      nav={nav}
      header={<ScreenHeader role={role.name} title="Change Password" onBack={onBack} />}
      footer={
        <ActionButton
          label="Send for approval  →"
          loadingLabel="Sending"
          tone="brand"
          loading={submit.busy}
          onPress={save}
        />
      }
    >
      <NoticeBar tone="info">
        A new password does not take effect until Yash or Manoj approves it. You'll keep using
        your current one until then.
      </NoticeBar>

      <Card title="Password">
        <Field
          label="Current password"
          value={current}
          onChangeText={(v) => { setCurrent(v); if (error) setError(null); }}
          secureTextEntry
          returnKeyType="next"
          onSubmitEditing={() => nextRef.current?.focus()}
          blurOnSubmit={false}
        />
        <Field
          ref={nextRef}
          label="New password"
          style={styles.spaced}
          value={next}
          onChangeText={(v) => { setNext(v); if (error) setError(null); }}
          placeholder="At least 8 characters"
          secureTextEntry
          returnKeyType="next"
          onSubmitEditing={() => confirmRef.current?.focus()}
          blurOnSubmit={false}
        />
        <Field
          ref={confirmRef}
          label="Confirm new password"
          style={styles.spaced}
          value={confirm}
          onChangeText={(v) => { setConfirm(v); if (error) setError(null); }}
          placeholder="Type it again"
          secureTextEntry
          returnKeyType="go"
          onSubmitEditing={save}
        />
        {error ? <NoticeBar tone="danger" style={styles.spaced}>{error}</NoticeBar> : null}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  spaced: { marginTop: 13 },
});
