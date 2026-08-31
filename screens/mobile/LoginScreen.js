import React from 'react';
import { View, ScrollView, KeyboardAvoidingView, Platform, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { COLORS } from '../../constants/colors';
import { useAuth } from '../../context/AuthContext';
import AppText from '../../components/AppText';
import Field from '../../components/mobile/Field';
import ActionButton from '../../components/mobile/ActionButton';
import NoticeBar from '../../components/mobile/NoticeBar';
import { PHONE_MAX_WIDTH } from '../../components/mobile/Screen';
import { useBreakpoint } from '../../hooks/useBreakpoint';

/**
 * 01 — Login. All staff; the account's grants decide what the app opens on.
 *
 * The card carries the letterhead rather than the page: the navy banner is the
 * client's, and the page stays quiet behind it.
 *
 * This signs in against `/auth/login`. There is deliberately no offline path —
 * the API client used to answer an unreachable server from a built-in mock that
 * did not check passwords, which signed anyone in as an administrator. A request
 * that cannot be answered fails here, visibly.
 *
 * There is deliberately NO list of staff accounts on this screen, in any build.
 *
 * It used to carry tap-to-fill chips for the nine seeded roles. They held no
 * password — they filled the username box and nothing more — but a roster of
 * valid usernames printed under the form undoes work the server does on
 * purpose: `/auth/login` returns one identical body for an unknown id, a wrong
 * password and a deactivated account, and runs a bcrypt compare even when no
 * user was found so the timing matches. All of that exists to avoid confirming
 * which accounts are real. Do not add the list back, not even behind `__DEV__`
 * — the test logins live in OPERATING-GUIDE.txt section 2.12 instead, which is
 * where a credential belongs.
 */
export default function LoginScreen() {
  const { signIn } = useAuth();
  const insets = useSafeAreaInsets();
  const { isDesktop } = useBreakpoint();
  const passwordRef = React.useRef(null);

  const [username, setUsername] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState(null);
  const [busy, setBusy] = React.useState(false);

  async function submit() {
    if (busy) return;

    if (!username.trim()) return setError('Enter your username.');
    if (!password) return setError('Enter your password.');

    setBusy(true);
    setError(null);

    const result = await signIn(username.trim(), password);

    // On success the navigator unmounts this screen, so only the failure path
    // touches state — setting it after a win warns about an unmounted update.
    if (!result.ok) {
      setError(result.message);
      setPassword('');
      setBusy(false);
      passwordRef.current?.focus();
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
              <AppText
                weight="bold"
                size="xxl"
                color={COLORS.white}
                style={styles.brand}
                numberOfLines={1}
                adjustsFontSizeToFit
              >
                K.L. ELECTRICALS
              </AppText>
              <AppText size="sm" color={COLORS.brandMuted} style={styles.place}>
                Lakhtokia, Guwahati
              </AppText>
            </View>

            <View style={styles.sheet}>
              <Field
                label="Username"
                value={username}
                onChangeText={(next) => {
                  setUsername(next);
                  if (error) setError(null);
                }}
                placeholder="Your username"
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="next"
                onSubmitEditing={() => passwordRef.current?.focus()}
                blurOnSubmit={false}
                editable={!busy}
                autoFocus={Platform.OS === 'web'}
              />

              <Field
                ref={passwordRef}
                label="Password"
                style={styles.spaced}
                value={password}
                onChangeText={(next) => {
                  setPassword(next);
                  if (error) setError(null);
                }}
                placeholder="Your password"
                secureTextEntry
                returnKeyType="go"
                onSubmitEditing={submit}
                editable={!busy}
              />

              {error ? <NoticeBar tone="danger" style={styles.notice}>{error}</NoticeBar> : null}

              <ActionButton
                label="Login  →"
                loadingLabel="Signing in"
                tone="brand"
                loading={busy}
                onPress={submit}
                style={styles.submit}
              />
            </View>
          </View>

          <AppText size="xs" color={COLORS.textMuted} style={styles.help}>
            Forgot password? Contact Yash
          </AppText>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: COLORS.background },
  // White on desktop rather than the app's grey: the card carries the navy
  // letterhead, and a plain sheet behind it lets that be the only colour on the
  // page.
  pageWide: { backgroundColor: COLORS.white },
  scroll: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 20 },
  column: { width: '100%', maxWidth: PHONE_MAX_WIDTH - 40, alignSelf: 'center' },

  card: {
    borderRadius: 18,
    // Clips the flat navy banner to the card's corners; without it the square
    // punches back out through the radius.
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
    paddingTop: 28,
    paddingBottom: 26,
  },
  brand: { letterSpacing: 0.6, textAlign: 'center' },
  place: { marginTop: 5, textAlign: 'center' },

  sheet: { paddingHorizontal: 22, paddingTop: 22, paddingBottom: 24 },
  spaced: { marginTop: 15 },
  notice: { marginTop: 14 },
  submit: { marginTop: 20 },

  help: { marginTop: 16, textAlign: 'center' },

});
