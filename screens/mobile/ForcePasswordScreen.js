import React from 'react';
import { View, ScrollView, KeyboardAvoidingView, Platform, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { COLORS } from '../../constants/colors';
import { useAuth } from '../../context/AuthContext';
import { describeError } from '../../services/api';
import { checkPassword } from '../../utils/password';
import api from '../../services/api';
import AppText from '../../components/AppText';
import Field from '../../components/mobile/Field';
import ActionButton from '../../components/mobile/ActionButton';
import NoticeBar from '../../components/mobile/NoticeBar';
import { PHONE_MAX_WIDTH } from '../../components/mobile/Screen';
import { useBreakpoint } from '../../hooks/useBreakpoint';

/**
 * The gate an account created by a seed script lands on.
 *
 * A password a script chose is in the repository, so it is not a secret. The
 * server marks such accounts `must_change_password` (migration 015) and
 * `authenticate` refuses every request from them except `/auth/me` and this
 * one — so this screen is not a suggestion the user can navigate around, it is
 * the only thing the account can currently do.
 *
 * It carries its own sign-out for the same reason the check-in gate does:
 * somebody who opened the app on the wrong account must be able to leave
 * without a password they do not have.
 *
 * There is no "skip". The whole value of the gate is that it cannot be
 * postponed — a "remind me later" makes it a notification, and the accounts
 * this exists for are precisely the ones nobody gets round to.
 */
export default function ForcePasswordScreen() {
  const { user, signOut, clearPasswordChange } = useAuth();
  const insets = useSafeAreaInsets();
  const { isDesktop } = useBreakpoint();

  const nextRef = React.useRef(null);
  const confirmRef = React.useRef(null);

  const [current, setCurrent] = React.useState('');
  const [next, setNext] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [error, setError] = React.useState(null);
  const [busy, setBusy] = React.useState(false);

  // The client copy of the policy, so the form can say what is wrong before a
  // round trip. The server applies the same rules and is the one that decides —
  // see utils/password.js, which is a deliberate duplicate of the backend's.
  const policyComplaint = next ? checkPassword(next) : null;

  async function submit() {
    if (busy) return;

    if (!current) return setError('Enter the password you signed in with.');
    if (policyComplaint) return setError(policyComplaint);
    if (next !== confirm) return setError('The two new passwords do not match.');
    if (next === current) return setError('The new password must be different.');

    setBusy(true);
    setError(null);

    try {
      await api.patch('/auth/change-password', {
        current_password: current,
        new_password: next,
      });
      // The server has cleared the flag; telling the context lets the navigator
      // render the app on the very next frame instead of round-tripping /me.
      clearPasswordChange();
    } catch (err) {
      setError(describeError(err));
      setCurrent('');
      setNext('');
      setConfirm('');
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={[styles.page, isDesktop ? styles.pageWide : null]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingTop: insets.top + 26, paddingBottom: insets.bottom + 26 },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.column}>
          <View style={styles.card}>
            <View style={styles.banner}>
              <AppText weight="bold" size="lg" color={COLORS.white} style={styles.brand}>
                Choose your password
              </AppText>
              <AppText size="sm" color={COLORS.brandMuted} style={styles.place}>
                {user?.name ? `Signed in as ${user.name}` : 'One step before you start'}
              </AppText>
            </View>

            <View style={styles.sheet}>
              <NoticeBar tone="warning">
                Your password was set by an administrator, which means more than
                one person knows it. Choose your own before you continue — nothing
                else in the app will open until you do.
              </NoticeBar>

              <Field
                label="Current password"
                style={styles.spaced}
                value={current}
                onChangeText={(v) => { setCurrent(v); if (error) setError(null); }}
                placeholder="The one you just signed in with"
                secureTextEntry
                returnKeyType="next"
                onSubmitEditing={() => nextRef.current?.focus()}
                blurOnSubmit={false}
                editable={!busy}
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
                editable={!busy}
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
                onSubmitEditing={submit}
                editable={!busy}
              />

              {error ? <NoticeBar tone="danger" style={styles.notice}>{error}</NoticeBar> : null}

              <ActionButton
                label="Save and continue  →"
                loadingLabel="Saving"
                tone="brand"
                loading={busy}
                onPress={submit}
                style={styles.submit}
              />
            </View>
          </View>

          {/* Wrong account, or a password they do not have: they must still be
              able to get out. Same reasoning as the check-in gate. */}
          <ActionButton
            label="Sign out"
            tone="neutral"
            onPress={signOut}
            style={styles.signOut}
          />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: COLORS.background },
  pageWide: { backgroundColor: COLORS.white },
  scroll: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 20 },
  column: { width: '100%', maxWidth: PHONE_MAX_WIDTH - 40, alignSelf: 'center' },

  card: {
    borderRadius: 18,
    overflow: 'hidden',
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    shadowColor: COLORS.text,
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.08,
    shadowRadius: 24,
    elevation: 4,
  },
  banner: {
    backgroundColor: COLORS.brand,
    alignItems: 'center',
    paddingHorizontal: 22,
    paddingTop: 26,
    paddingBottom: 24,
  },
  brand: { letterSpacing: 0.4, textAlign: 'center' },
  place: { marginTop: 5, textAlign: 'center' },

  sheet: { paddingHorizontal: 22, paddingTop: 20, paddingBottom: 24 },
  spaced: { marginTop: 15 },
  notice: { marginTop: 14 },
  submit: { marginTop: 20 },
  signOut: { marginTop: 16 },
});
