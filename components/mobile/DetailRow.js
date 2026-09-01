import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useThemeColors } from '../../context/ThemeContext';
import AppText from '../AppText';

/**
 * One label-and-value line inside a card — Party / Sharma Electricals,
 * Outstanding / ₹23,000 · 45d ⚠.
 *
 * The value is the answer the reader came for, so it is bold and right-aligned
 * against the card edge while the label stays quiet on the left. `tone` inks the
 * value where the number itself is the warning.
 */
function makeTONES(COLORS) {
  return {
  default: COLORS.text,
  warning: COLORS.warning,
  danger: COLORS.error,
  success: COLORS.success,
  brand: COLORS.brand,
  muted: COLORS.textSecondary,
};
}

export default function DetailRow({ label, value, tone = 'default', last = false, children }) {
  const COLORS = useThemeColors();
  const TONES = React.useMemo(() => makeTONES(COLORS), [COLORS]);
  const styles = React.useMemo(() => StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  ruled: { borderBottomWidth: 1, borderBottomColor: COLORS.borderLight },
  label: { marginRight: 14 },
  // Flexed and right-aligned so a long value wraps within the card instead of
  // shouldering the label off the left edge.
  value: { flex: 1, textAlign: 'right' },
}), [COLORS]);
  return (
    <View style={[styles.row, last ? null : styles.ruled]}>
      <AppText size="sm" color={COLORS.textSecondary} style={styles.label}>
        {label}
      </AppText>
      {children || (
        <AppText
          weight="bold"
          size="sm"
          color={TONES[tone] || TONES.default}
          style={styles.value}
        >
          {value}
        </AppText>
      )}
    </View>
  );
}

