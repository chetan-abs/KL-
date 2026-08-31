import React from 'react';
import { View, TouchableOpacity, Modal, Pressable, StyleSheet } from 'react-native';
import { COLORS } from '../../constants/colors';
import AppText from '../AppText';

/**
 * A dropdown that looks like `Field` and opens a sheet of options.
 *
 * Not the platform picker: `@react-native-picker/picker` is not a dependency
 * here, and the web build of the native one renders an unstyled `<select>` that
 * ignores every token in the palette. A modal list is the same on all three
 * targets, which is what the mockups show.
 */
export default function Select({ label, required, value, options = [], onChange, placeholder = 'Select…', style }) {
  const [open, setOpen] = React.useState(false);
  const selected = options.find((option) => option.value === value);

  return (
    <View style={style}>
      {label ? (
        <AppText size="xs" color={COLORS.textSecondary} style={styles.label}>
          {label}
          {required ? <AppText size="xs" color={COLORS.error}> *</AppText> : null}
        </AppText>
      ) : null}

      <TouchableOpacity
        style={styles.box}
        onPress={() => setOpen(true)}
        activeOpacity={0.75}
        accessibilityRole="button"
        accessibilityLabel={`${label || 'Select'}: ${selected?.label || placeholder}`}
      >
        <AppText size="md" color={selected ? COLORS.text : COLORS.textMuted} numberOfLines={1} style={styles.flex}>
          {selected?.label || placeholder}
        </AppText>
        <AppText size="sm" color={COLORS.textSecondary}>⌄</AppText>
      </TouchableOpacity>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <View style={styles.sheet}>
            {label ? (
              <AppText weight="bold" size={11} color={COLORS.textSecondary} style={styles.sheetTitle}>
                {label.toUpperCase()}
              </AppText>
            ) : null}
            {options.map((option) => {
              const on = option.value === value;
              return (
                <TouchableOpacity
                  key={option.value}
                  style={styles.option}
                  onPress={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  accessibilityRole="menuitem"
                  accessibilityState={{ selected: on }}
                >
                  <AppText
                    weight={on ? 'bold' : 'regular'}
                    size="md"
                    color={on ? COLORS.brand : COLORS.text}
                    style={styles.flex}
                  >
                    {option.label}
                  </AppText>
                  {on ? <AppText size="sm" color={COLORS.brand}>✓</AppText> : null}
                </TouchableOpacity>
              );
            })}
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  label: { marginBottom: 6 },
  box: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 46,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 9,
    paddingHorizontal: 13,
    backgroundColor: COLORS.surface,
    gap: 8,
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: COLORS.surface,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingVertical: 10,
    paddingBottom: 26,
  },
  sheetTitle: { letterSpacing: 0.8, paddingHorizontal: 20, paddingVertical: 10 },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 15,
    paddingHorizontal: 20,
  },
});
