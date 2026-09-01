import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useThemeColors } from '../../context/ThemeContext';
import AppText from '../AppText';

/**
 * The initials disc beside a party in a list — SE, BT, GE.
 *
 * The fill is chosen from the name rather than stored, so the same party keeps
 * the same colour on every screen it appears on without anything having to
 * record which colour it was given. A trading name is what the user recognises,
 * so the initials come from its first two words.
 */
function initialsOf(name = '') {
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '??';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function colorOf(name = '', COLORS) {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) % 100000;
  }
  return COLORS.avatarPalette[hash % COLORS.avatarPalette.length];
}

export default function Avatar({ name, label, color, size = 40, style }) {
  const COLORS = useThemeColors();
  const styles = React.useMemo(() => StyleSheet.create({
  disc: { alignItems: 'center', justifyContent: 'center' },
}), [COLORS]);
  const text = label || initialsOf(name);

  return (
    <View
      style={[
        styles.disc,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: color || colorOf(name || text, COLORS),
        },
        style,
      ]}
    >
      <AppText weight="bold" size={size < 34 ? 11 : 'sm'} color={COLORS.white}>
        {text}
      </AppText>
    </View>
  );
}

