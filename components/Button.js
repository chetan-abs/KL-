import React from 'react';
import { TouchableOpacity, ActivityIndicator, StyleSheet, View } from 'react-native';
import { COLORS } from '../constants/colors';
import AppText from './AppText';

/**
 * Primary action. `variant="quiet"` is the outlined form for anything that is
 * not the main thing on the screen. `variant="brand"` is the navy fill used
 * where the button sits under the brand banner, as on the sign-in screen.
 *
 * While `loading`, the label changes rather than being replaced by a spinner
 * alone — a button whose text vanishes reads as broken, and the changed verb
 * says which action is in flight.
 */
export default function Button({
  label,
  loadingLabel,
  onPress,
  loading = false,
  disabled = false,
  variant = 'primary',
  accessibilityLabel,
  style,
}) {
  const quiet = variant === 'quiet';
  const brand = variant === 'brand';
  const inert = disabled || loading;

  // A disabled control gets its own surface rather than a faded primary one.
  // Reducing opacity on a filled button reads as "pressed" or "still loading",
  // which is the opposite of the state being communicated.
  const surface = inert
    ? quiet
      ? styles.quietInert
      : styles.primaryInert
    : quiet
      ? styles.quiet
      : brand
        ? styles.brand
        : styles.primary;

  const labelColor = inert
    ? COLORS.disabledText
    : quiet
      ? COLORS.textSecondary
      : brand
        ? COLORS.textOnBrand
        : COLORS.textOnPrimary;

  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={inert}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityState={{ disabled: inert, busy: loading }}
      accessibilityLabel={accessibilityLabel || (loading ? loadingLabel || label : label)}
      style={[styles.base, surface, style]}
    >
      <View style={styles.row}>
        {loading ? (
          <ActivityIndicator size="small" color={labelColor} style={styles.spinner} />
        ) : null}
        <AppText weight="bold" size="md" color={labelColor} style={styles.label}>
          {loading ? loadingLabel || label : label}
        </AppText>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: 56,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  row: { flexDirection: 'row', alignItems: 'center' },
  spinner: { marginRight: 10 },
  label: { letterSpacing: 0.2 },

  primary: {
    backgroundColor: COLORS.primary,
    shadowColor: COLORS.primaryDark,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.22,
    shadowRadius: 10,
    elevation: 3,
  },
  primaryInert: { backgroundColor: COLORS.disabled },

  brand: {
    backgroundColor: COLORS.brand,
    shadowColor: COLORS.brandDark,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.24,
    shadowRadius: 10,
    elevation: 3,
  },

  quiet: { backgroundColor: COLORS.transparent, borderWidth: 1.5, borderColor: COLORS.border },
  quietInert: { backgroundColor: COLORS.transparent, borderWidth: 1.5, borderColor: COLORS.divider },
});
