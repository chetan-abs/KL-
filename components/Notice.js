import React from 'react';
import { View, StyleSheet } from 'react-native';
import { COLORS } from '../constants/colors';
import AppText from './AppText';

const TONES = {
  error: { bg: COLORS.errorLight, rule: COLORS.error, text: COLORS.errorDark },
  warning: { bg: COLORS.warningLight, rule: COLORS.warning, text: COLORS.warningDark },
  info: { bg: COLORS.primaryLight, rule: COLORS.primary, text: COLORS.text },
};

/**
 * A block-level message attached to a form or a screen.
 *
 * The tone is carried by a rule down the leading edge rather than an icon, so
 * the meaning survives without an icon set installed and stays legible for
 * anyone who cannot distinguish the fill colour.
 *
 * `live` announces the message to a screen reader when it appears — correct for
 * a submission failure the reader did not navigate to, wrong for a hint that
 * was always on screen.
 */
export default function Notice({ tone = 'error', title, children, live = true, style }) {
  const palette = TONES[tone] || TONES.error;

  return (
    <View
      style={[styles.wrap, { backgroundColor: palette.bg, borderLeftColor: palette.rule }, style]}
      accessibilityLiveRegion={live ? 'polite' : 'none'}
      accessibilityRole="alert"
    >
      {title ? (
        <AppText weight="bold" size="sm" color={palette.text} style={styles.title}>
          {title}
        </AppText>
      ) : null}
      <AppText size="sm" color={palette.text} style={styles.body}>
        {children}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderLeftWidth: 3,
    borderRadius: 10,
    paddingVertical: 13,
    paddingHorizontal: 15,
  },
  title: { marginBottom: 3 },
  body: { lineHeight: 20 },
});
