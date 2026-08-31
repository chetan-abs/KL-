import React from 'react';
import { View, TouchableOpacity, StyleSheet } from 'react-native';
import { COLORS } from '../../constants/colors';
import AppText from '../AppText';

/**
 * The side-by-side selectable tiles — Builder Agent / Elec · Interior.
 *
 * A pair of tiles rather than a segmented control or a picker because each
 * option carries a consequence the user must read before choosing (which
 * commission column applies), and that caption has nowhere to live inside a
 * segment.
 *
 * The selected tile takes a tinted fill *and* a heavier border. Border alone is
 * too quiet at this size, and fill alone is ambiguous next to the amber accent
 * the second option already uses.
 */
export default function ChoiceCards({ options = [], value, onChange, style }) {
  return (
    <View style={[styles.row, style]}>
      {options.map((option) => {
        const on = option.value === value;
        const accent = option.accent || COLORS.primary;

        return (
          <TouchableOpacity
            key={option.value}
            style={[
              styles.tile,
              on ? { borderColor: accent, backgroundColor: `${accent}14` } : null,
            ]}
            onPress={() => onChange(option.value)}
            activeOpacity={0.8}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            accessibilityLabel={option.label}
          >
            {option.glyph ? (
              <AppText size="lg" style={styles.glyph}>
                {option.glyph}
              </AppText>
            ) : null}
            <AppText weight="bold" size="sm" color={on ? accent : COLORS.text} style={styles.label}>
              {option.label}
            </AppText>
            {option.caption ? (
              <AppText size={11} color={COLORS.textMuted} style={styles.caption}>
                {option.caption}
              </AppText>
            ) : null}
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 11 },
  tile: {
    flex: 1,
    // Carried at the selected weight in both states, recoloured rather than
    // thickened — a border that grows on selection reflows the tile's contents
    // and nudges its neighbour sideways.
    borderWidth: 2,
    borderColor: COLORS.border,
    borderRadius: 11,
    backgroundColor: COLORS.surface,
    paddingVertical: 15,
    paddingHorizontal: 10,
    alignItems: 'center',
  },
  glyph: { marginBottom: 5 },
  label: { textAlign: 'center' },
  caption: { marginTop: 3, textAlign: 'center' },
});
