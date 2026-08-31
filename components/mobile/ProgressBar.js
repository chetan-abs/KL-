import React from 'react';
import { View, StyleSheet } from 'react-native';
import { COLORS } from '../../constants/colors';

/**
 * The thin fill under "ITEMS (3/5 DONE)".
 *
 * Clamped rather than trusted: a picker who over-picks reports more than the
 * target, and an unclamped ratio draws the fill past the end of its own track.
 */
export default function ProgressBar({ value = 0, total = 1, tone = COLORS.brand, style }) {
  const ratio = total > 0 ? Math.max(0, Math.min(1, value / total)) : 0;

  return (
    <View style={[styles.track, style]}>
      <View style={[styles.fill, { width: `${ratio * 100}%`, backgroundColor: tone }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    height: 7,
    borderRadius: 4,
    backgroundColor: COLORS.surfaceLight,
    overflow: 'hidden',
  },
  fill: { height: '100%', borderRadius: 4 },
});
