import React from 'react';
import { View, StyleSheet } from 'react-native';
import { COLORS } from '../../constants/colors';
import AppText from '../AppText';

/**
 * The full-width message strip the mockups place directly under a header or
 * above an action — "Load REVERSE", "Mismatch: Anchor MCB", "Photo = delivery
 * proof".
 *
 * Distinct from `components/Notice.js`, which is the web panel's form-level
 * message and marks tone with a rule down its leading edge. Here the whole strip
 * is the signal: it is tinted, outlined, and carries a leading glyph, because on
 * a phone it is often the only thing between the header and a destructive
 * button.
 */
const TONES = {
  warning: { bg: COLORS.warningSurface, border: COLORS.warningBorder, text: COLORS.warningDark, glyph: '⚠' },
  danger: { bg: COLORS.errorSurface, border: COLORS.errorBorder, text: COLORS.actionRejectDark, glyph: '⚠' },
  success: { bg: COLORS.successSurface, border: COLORS.successBorder, text: COLORS.successDark, glyph: '✓' },
  info: { bg: COLORS.infoSurface, border: COLORS.infoBorder, text: COLORS.infoDark, glyph: '📍' },
  violet: { bg: COLORS.violetSurface, border: COLORS.violetBorder, text: COLORS.violetDark, glyph: '💡' },
};

export default function NoticeBar({ tone = 'warning', glyph, children, style }) {
  const palette = TONES[tone] || TONES.warning;
  const mark = glyph === null ? null : glyph || palette.glyph;

  return (
    <View
      style={[styles.bar, { backgroundColor: palette.bg, borderColor: palette.border }, style]}
      accessibilityRole="alert"
    >
      {mark ? (
        <AppText size="sm" color={palette.text} style={styles.glyph}>
          {mark}
        </AppText>
      ) : null}
      <AppText size="sm" color={palette.text} style={styles.text}>
        {children}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 13,
  },
  glyph: { marginRight: 8, lineHeight: 20 },
  // Without the basis the text box refuses to wrap inside a row and pushes its
  // tail off the card's right edge instead of breaking onto a second line.
  text: { flex: 1, lineHeight: 20 },
});
