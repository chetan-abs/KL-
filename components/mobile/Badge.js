import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useThemeColors } from '../../context/ThemeContext';
import AppText from '../AppText';

/**
 * The pill that sits at the top-right of a header, or beside a list row.
 *
 * Tones are named for what they mean, not what colour they are — a screen asks
 * for `pending`, never for amber — so the palette can move without a sweep
 * through 27 screens.
 */
function makeTONES(COLORS) {
  return {
  pending: { bg: COLORS.warningSurface, text: COLORS.warningDark },
  warning: { bg: COLORS.warningSurface, text: COLORS.warningDark },
  danger: { bg: COLORS.errorSurface, text: COLORS.actionRejectDark },
  success: { bg: COLORS.successSurface, text: COLORS.successDark },
  info: { bg: COLORS.infoSurface, text: COLORS.infoDark },
  violet: { bg: COLORS.violetSurface, text: COLORS.violetDark },
  neutral: { bg: COLORS.surfaceLight, text: COLORS.textSecondary },
  // Set on the navy header, where a tinted fill would disappear.
  onBrand: { bg: 'rgba(255,255,255,0.16)', text: COLORS.white },
};
}

export default function Badge({ tone = 'neutral', children, style }) {
  const COLORS = useThemeColors();
  const TONES = React.useMemo(() => makeTONES(COLORS), [COLORS]);
  const styles = React.useMemo(() => StyleSheet.create({
  pill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    alignSelf: 'flex-start',
  },
  label: { letterSpacing: 0.4, textTransform: 'uppercase' },
}), [COLORS]);
  const palette = TONES[tone] || TONES.neutral;

  return (
    <View style={[styles.pill, { backgroundColor: palette.bg }, style]}>
      <AppText weight="bold" size={11} color={palette.text} style={styles.label}>
        {children}
      </AppText>
    </View>
  );
}

