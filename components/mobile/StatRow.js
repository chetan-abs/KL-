import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useThemeColors } from '../../context/ThemeContext';
import AppText from '../AppText';

/**
 * The three-up figure strip under a header — 14 Pending / 38 Approved /
 * 2 Rejected.
 *
 * Each stat carries its own ink because the colour is the whole point of the
 * strip: the eye lands on the red figure before it reads the word under it.
 * Callers pass a palette key, not a hex, so `tone="danger"` stays right if the
 * red moves.
 */
function makeTONES(COLORS) {
  return {
  pending: COLORS.warning,
  warning: COLORS.warning,
  success: COLORS.success,
  danger: COLORS.error,
  info: COLORS.primary,
  brand: COLORS.brand,
  neutral: COLORS.text,
};
}

export default function StatRow({ stats = [], style }) {
  const COLORS = useThemeColors();
  const TONES = React.useMemo(() => makeTONES(COLORS), [COLORS]);
  const styles = React.useMemo(() => StyleSheet.create({
  row: {
    flexDirection: 'row',
    backgroundColor: COLORS.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingVertical: 14,
  },
  cell: { flex: 1, alignItems: 'center' },
  divider: { width: 1, backgroundColor: COLORS.border, marginVertical: 4 },
  label: { marginTop: 3 },
}), [COLORS]);
  return (
    <View style={[styles.row, style]}>
      {stats.map((stat, index) => (
        <React.Fragment key={stat.label}>
          {index > 0 ? <View style={styles.divider} /> : null}
          <View style={styles.cell}>
            <AppText weight="bold" size="xl" color={TONES[stat.tone] || TONES.neutral}>
              {stat.value}
            </AppText>
            <AppText size="xs" color={COLORS.textSecondary} style={styles.label}>
              {stat.label}
            </AppText>
          </View>
        </React.Fragment>
      ))}
    </View>
  );
}

