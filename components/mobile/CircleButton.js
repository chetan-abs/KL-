import React from 'react';
import { TouchableOpacity, StyleSheet } from 'react-native';
import { COLORS } from '../../constants/colors';
import AppText from '../AppText';

/**
 * The round mark-outcome control at the right of a picker or verify row.
 *
 * Filled once the row has an outcome, pale while it is still a choice: on the
 * picker sheet an undecided row offers a pale ✓ and a pale ✗ side by side, and a
 * decided one collapses to a single filled disc. Colour alone would not survive
 * that, so the glyph is always drawn.
 */
const TONES = {
  success: { on: COLORS.actionApprove, off: COLORS.successRow, ink: COLORS.successDark },
  warning: { on: COLORS.warning, off: COLORS.warningRow, ink: COLORS.warningDark },
  danger: { on: COLORS.actionReject, off: COLORS.errorRow, ink: COLORS.actionRejectDark },
};

export default function CircleButton({
  glyph,
  tone = 'success',
  filled = true,
  size = 38,
  onPress,
  accessibilityLabel,
  style,
}) {
  const palette = TONES[tone] || TONES.success;

  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={!onPress}
      activeOpacity={0.75}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={[
        styles.disc,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: filled ? palette.on : palette.off,
        },
        style,
      ]}
    >
      <AppText weight="bold" size="md" color={filled ? COLORS.white : palette.ink}>
        {glyph}
      </AppText>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  disc: { alignItems: 'center', justifyContent: 'center' },
});
