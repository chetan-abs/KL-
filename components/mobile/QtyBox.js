import React from 'react';
import { View, TextInput, StyleSheet } from 'react-native';
import { COLORS } from '../../constants/colors';
import { TYPOGRAPHY } from '../../constants/typography';
import AppText from '../AppText';

/**
 * The small bordered number box used for counting against a target —
 * "Picked/Need [5]/5" on the picker sheet, "Counted [8]" on the verify sheet.
 *
 * The box is inked by outcome, not by whether it is focused: a short count is
 * red the moment it is short, because the picker is walking a godown and reads
 * the colour, not the numbers. `tone` is decided by the caller since only it
 * knows whether "0 of 6" means not-yet-picked or not-found.
 */
const TONES = {
  neutral: { border: COLORS.border, text: COLORS.text },
  success: { border: COLORS.success, text: COLORS.successDark },
  warning: { border: COLORS.warning, text: COLORS.warningDark },
  danger: { border: COLORS.error, text: COLORS.actionRejectDark },
};

export default function QtyBox({ value, onChangeText, target, tone = 'neutral', editable = true, label }) {
  const palette = TONES[tone] || TONES.neutral;

  return (
    <View style={styles.wrap}>
      {label ? (
        <AppText size={10} color={COLORS.textSecondary} style={styles.label}>
          {label}
        </AppText>
      ) : null}
      <View style={styles.row}>
        <TextInput
          value={String(value ?? '')}
          onChangeText={onChangeText}
          editable={editable}
          keyboardType="number-pad"
          selectTextOnFocus
          style={[styles.box, { borderColor: palette.border, color: palette.text }]}
          accessibilityLabel={label || 'Quantity'}
        />
        {target !== undefined ? (
          <AppText size="xs" color={COLORS.textSecondary} style={styles.target}>
            {`/${target}`}
          </AppText>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center' },
  label: { marginBottom: 3 },
  row: { flexDirection: 'row', alignItems: 'center' },
  box: {
    width: 50,
    height: 38,
    borderWidth: 2,
    borderRadius: 8,
    textAlign: 'center',
    backgroundColor: COLORS.surface,
    fontFamily: TYPOGRAPHY.fontFamily.bold,
    fontSize: TYPOGRAPHY.size.md,
    outlineStyle: 'none',
  },
  target: { marginLeft: 4 },
});
