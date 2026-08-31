import React from 'react';
import {
  View,
  Image,
  StyleSheet,
  KeyboardAvoidingView,
  ScrollView,
  Platform,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { COLORS } from '../constants/colors';
import AppText from '../components/AppText';
import TextField from '../components/TextField';
import Button from '../components/Button';
import Notice from '../components/Notice';
import { useAuth } from '../context/AuthContext';

// Below this the card gives up some of its breathing room: on a short phone the
// gap above it is the first thing worth spending, not the form's own spacing.
const COMPACT_HEIGHT = 700;

export default function LoginScreen() {
  const { signIn } = useAuth();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const passwordRef = React.useRef(null);

  const [id, setId] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [reveal, setReveal] = React.useState(false);
  const [fieldErrors, setFieldErrors] = React.useState({});
  const [formError, setFormError] = React.useState(null);
  const [capsLock, setCapsLock] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const compact = height < COMPACT_HEIGHT;

  function clearErrors() {
    if (formError) setFormError(null);
    if (fieldErrors.id || fieldErrors.password) setFieldErrors({});
  }

  // Caps Lock is the single most common cause of a password that the person
  // typing is certain is correct. Only web reports modifier state.
  function trackCapsLock(event) {
    if (Platform.OS !== 'web') return;
    const state = event?.nativeEvent?.getModifierState?.('CapsLock');
    if (typeof state === 'boolean') setCapsLock(state);
  }

  async function submit() {
    if (busy) return;

    // Validated here rather than by disabling the button: a disabled control
    // gives no reason, so the reader is left guessing which field is at fault.
    const next = {};
    if (!id.trim()) next.id = 'Enter your username.';
    if (!password) next.password = 'Enter your password.';

    if (Object.keys(next).length) {
      setFieldErrors(next);
      setFormError(null);
      return;
    }

    setBusy(true);
    setFieldErrors({});
    setFormError(null);

    const result = await signIn(id.trim(), password);

    // On success the navigator unmounts this screen, so only the failure path
    // touches state — setting it after a win warns about an unmounted update.
    if (!result.ok) {
      setFormError(result.message);
      setPassword('');
      setBusy(false);
      passwordRef.current?.focus();
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          {
            paddingTop: insets.top + (compact ? 28 : 40),
            paddingBottom: insets.bottom + 28,
          },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.column}>
          {/* The builder's mark sits outside the card, above it — the page's
              own signature, kept clear of the client's letterhead inside. */}
          <Image
            source={require('../assets/abs_logo_redesign.png')}
            style={styles.logo}
            resizeMode="contain"
            accessibilityRole="image"
            accessibilityLabel="ABS Technologies"
          />

          <View style={styles.card}>
            <View style={styles.banner}>
              <AppText
                weight="bold"
                size="xl"
                color={COLORS.textOnBrand}
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
              <TextField
                label="Username"
                tracked
                value={id}
                onChangeText={(next) => {
                  setId(next);
                  clearErrors();
                }}
                error={fieldErrors.id}
                placeholder="Enter your username"
                returnKeyType="next"
                onSubmitEditing={() => passwordRef.current?.focus()}
                blurOnSubmit={false}
                textContentType="username"
                autoComplete="username"
                editable={!busy}
                autoFocus={Platform.OS === 'web'}
              />

              <TextField
                ref={passwordRef}
                label="Password"
                style={styles.spaced}
                value={password}
                onChangeText={(next) => {
                  setPassword(next);
                  clearErrors();
                }}
                onKeyPress={trackCapsLock}
                error={fieldErrors.password}
                placeholder="Enter your password"
                secureTextEntry={!reveal}
                returnKeyType="go"
                onSubmitEditing={submit}
                textContentType="password"
                autoComplete="password"
                editable={!busy}
                iconAction={{
                  icon: reveal ? 'eye-off-outline' : 'eye-outline',
                  accessibilityLabel: reveal ? 'Hide password' : 'Show password',
                  active: reveal,
                  onPress: () => setReveal((v) => !v),
                }}
              />

              {capsLock ? (
                <Notice tone="warning" style={styles.notice} live={false}>
                  Caps Lock is on.
                </Notice>
              ) : null}

              {formError ? (
                <Notice tone="error" style={styles.notice}>
                  {formError}
                </Notice>
              ) : null}

              {/* The arrow is decoration; the name of the action is the label
                  alone, so that is what assistive tech is given. */}
              <Button
                variant="brand"
                label="Login  →"
                loadingLabel="Logging in"
                accessibilityLabel={busy ? 'Logging in' : 'Login'}
                onPress={submit}
                loading={busy}
                style={styles.submit}
              />

              <AppText size="xs" color={COLORS.textMuted} style={styles.help}>
                Forgot your password? Contact your administrator.
              </AppText>
            </View>
          </View>

          <AppText size="xs" color={COLORS.textMuted} style={styles.foot}>
            Designed and Developed by ABS Technologies
          </AppText>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: COLORS.background },
  scroll: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
  },

  column: { width: '100%', maxWidth: 420, alignSelf: 'center' },

  // `contain` fits the art inside the box, so height is what actually caps the
  // drawn width: at 1024×682 the source is 1.5:1, and a box any taller per unit
  // width letterboxes it. Change the two together or the mark shrinks instead.
  logo: { width: 108, height: 72, alignSelf: 'center', marginBottom: 16 },

  card: {
    borderRadius: 22,
    // Clips the navy header to the card's radius; without it the flat navy
    // square punches back out through the rounded corners.
    overflow: 'hidden',
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    shadowColor: COLORS.text,
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.09,
    shadowRadius: 28,
    elevation: 4,
  },

  // The client's letterhead, set inside the card rather than on the page, so
  // the card carries the name and the page stays quiet behind it.
  banner: {
    backgroundColor: COLORS.brand,
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: 26,
    paddingBottom: 24,
  },
  brand: { letterSpacing: 1.2, textAlign: 'center' },
  place: { marginTop: 6, textAlign: 'center' },

  sheet: {
    paddingHorizontal: 26,
    paddingTop: 30,
    paddingBottom: 28,
  },

  spaced: { marginTop: 18 },
  notice: { marginTop: 16 },
  submit: { marginTop: 26 },

  help: { marginTop: 20, lineHeight: 17, textAlign: 'center' },
  foot: { marginTop: 22, lineHeight: 17, textAlign: 'center' },
});
