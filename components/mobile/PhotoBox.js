import React from 'react';
import { TouchableOpacity, StyleSheet } from 'react-native';
import { COLORS } from '../../constants/colors';
import AppText from '../AppText';

/**
 * The dashed capture target — "Photo of delivered goods", "Proof photo".
 *
 * Dashed because it is an empty slot asking to be filled, not a card. Once
 * captured it goes solid and green: on the delivery screen the photo *is* the
 * proof of delivery (there is no party signature), so "have I taken it yet" must
 * be answerable from across a loading bay.
 */
export default function PhotoBox({
  glyph = '📦',
  title,
  caption,
  captured = false,
  compact = false,
  onPress,
  style,
}) {
  return (
    <TouchableOpacity
      style={[
        compact ? styles.compact : styles.box,
        captured ? styles.captured : styles.empty,
        style,
      ]}
      onPress={onPress}
      activeOpacity={0.75}
      accessibilityRole="button"
      accessibilityLabel={captured ? `${title} — captured` : title}
    >
      <AppText size={compact ? 'sm' : 'xl'}>{captured ? '✅' : glyph}</AppText>
      <AppText
        weight="bold"
        size="sm"
        color={captured ? COLORS.successDark : COLORS.textSecondary}
        style={compact ? null : styles.title}
      >
        {captured ? 'Photo captured' : title}
      </AppText>
      {caption && !captured ? (
        <AppText size="xs" color={COLORS.textMuted} style={styles.caption}>
          {caption}
        </AppText>
      ) : null}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  box: {
    borderWidth: 2,
    borderStyle: 'dashed',
    borderRadius: 11,
    paddingVertical: 26,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  compact: {
    flexDirection: 'row',
    gap: 8,
    borderWidth: 2,
    borderStyle: 'dashed',
    borderRadius: 9,
    paddingVertical: 13,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  empty: { borderColor: COLORS.successBorder, backgroundColor: COLORS.successRow },
  captured: { borderColor: COLORS.success, backgroundColor: COLORS.successSurface, borderStyle: 'solid' },
  title: { marginTop: 6, textAlign: 'center' },
  caption: { marginTop: 3, textAlign: 'center' },
});
