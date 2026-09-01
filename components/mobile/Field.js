import React from 'react';
import { View, TextInput, StyleSheet } from 'react-native';
import { useThemeColors } from '../../context/ThemeContext';
import { TYPOGRAPHY } from '../../constants/typography';
import AppText from '../AppText';

/**
 * A labelled input, label sitting above the box.
 *
 * `components/TextField.js` is the web panel's field and carries a floating
 * label, a trailing icon action and tracked validation. The phone mockups use a
 * plainer form — quiet label, single-line box, hint underneath — and the label
 * stays put because these forms are short and a moving label costs more
 * attention than it saves.
 *
 * A required field is marked with an asterisk in the label rather than a
 * separate note, matching "AGENT TYPE *" and "DELIVERY PHOTO * (MANDATORY)".
 */
const Field = React.forwardRef(function Field(
  { label, required, hint, error, right, style, inputStyle, ...props },
  ref
) {
  const COLORS = useThemeColors();
  const styles = React.useMemo(() => StyleSheet.create({
    label: { marginBottom: 6 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 9 },
    input: {
      flex: 1,
      minHeight: 46,
      borderWidth: 1,
      borderColor: COLORS.border,
      borderRadius: 9,
      paddingHorizontal: 13,
      paddingVertical: 11,
      backgroundColor: COLORS.surface,
      color: COLORS.text,
      fontFamily: TYPOGRAPHY.fontFamily.regular,
      fontSize: TYPOGRAPHY.size.md,
      // Kills the browser's own focus ring on web, which is a square outline that
      // ignores the 9px radius and sits a pixel outside the border.
      outlineStyle: 'none',
    },
    inputError: { borderColor: COLORS.error },
    note: { marginTop: 5 },
  }), [COLORS]);

  return (
    <View style={style}>
      {label ? (
        <AppText size="xs" color={COLORS.textSecondary} style={styles.label}>
          {label}
          {required ? <AppText size="xs" color={COLORS.error}> *</AppText> : null}
        </AppText>
      ) : null}

      <View style={styles.row}>
        <TextInput
          ref={ref}
          placeholderTextColor={COLORS.textMuted}
          style={[styles.input, error ? styles.inputError : null, inputStyle]}
          {...props}
        />
        {right}
      </View>

      {error ? (
        <AppText size="xs" color={COLORS.errorDark} style={styles.note}>
          {error}
        </AppText>
      ) : hint ? (
        <AppText size="xs" color={COLORS.textMuted} style={styles.note}>
          {hint}
        </AppText>
      ) : null}
    </View>
  );
});

export default Field;
