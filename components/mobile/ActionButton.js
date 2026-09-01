import React from 'react';
import { TouchableOpacity, ActivityIndicator, View, StyleSheet } from 'react-native';
import { useThemeColors } from '../../context/ThemeContext';
import AppText from '../AppText';

/**
 * The large full-width action at the foot of a phone screen.
 *
 * `components/Button.js` is the web panel's control and knows three variants.
 * These screens need the mockups' colour-coded verbs — a red Reject beside a
 * green Approve, a teal Save, a grey alternate route — where the fill *is* the
 * meaning and the pair is read at a glance before the label is.
 *
 * A disabled button takes its own flat surface rather than a faded fill, for the
 * reason `Button` gives: dimming a coloured fill reads as "in flight", which is
 * the opposite of "you cannot do this yet".
 */
function makeTONES(COLORS) {
  return {
  brand: { bg: COLORS.brand, shadow: COLORS.brandDark, text: COLORS.textOnBrand },
  approve: { bg: COLORS.actionApprove, shadow: COLORS.actionApproveDark, text: COLORS.white },
  reject: { bg: COLORS.actionReject, shadow: COLORS.actionRejectDark, text: COLORS.white },
  neutral: { bg: COLORS.actionNeutral, shadow: COLORS.actionNeutralDark, text: COLORS.white },
  teal: { bg: COLORS.actionTeal, shadow: COLORS.actionTealDark, text: COLORS.white },
  primary: { bg: COLORS.primary, shadow: COLORS.primaryDark, text: COLORS.textOnPrimary },
};
}

export default function ActionButton({
  label,
  loadingLabel,
  tone = 'brand',
  onPress,
  loading = false,
  disabled = false,
  size = 'md',
  accessibilityLabel,
  style,
}) {
  const COLORS = useThemeColors();
  const TONES = React.useMemo(() => makeTONES(COLORS), [COLORS]);
  const styles = React.useMemo(() => StyleSheet.create({
  base: {
    borderRadius: 11,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  md: { minHeight: 54 },
  sm: { minHeight: 40, borderRadius: 9 },
  row: { flexDirection: 'row', alignItems: 'center' },
  spinner: { marginRight: 9 },
  inert: { backgroundColor: COLORS.disabled },
}), [COLORS]);
  const palette = TONES[tone] || TONES.brand;
  const inert = disabled || loading;
  const small = size === 'sm';

  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={inert}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityState={{ disabled: inert, busy: loading }}
      accessibilityLabel={accessibilityLabel || (loading ? loadingLabel || label : label)}
      style={[
        styles.base,
        small ? styles.sm : styles.md,
        inert
          ? styles.inert
          : {
              backgroundColor: palette.bg,
              shadowColor: palette.shadow,
              shadowOffset: { width: 0, height: 3 },
              shadowOpacity: 0.22,
              shadowRadius: 8,
              elevation: 2,
            },
        style,
      ]}
    >
      <View style={styles.row}>
        {loading ? (
          <ActivityIndicator
            size="small"
            color={inert ? COLORS.disabledText : palette.text}
            style={styles.spinner}
          />
        ) : null}
        <AppText
          weight="bold"
          size={small ? 'sm' : 'md'}
          color={inert ? COLORS.disabledText : palette.text}
        >
          {loading ? loadingLabel || label : label}
        </AppText>
      </View>
    </TouchableOpacity>
  );
}

