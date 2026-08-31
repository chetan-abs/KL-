import React from 'react';
import { View, TextInput, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { COLORS } from '../constants/colors';
import { TYPOGRAPHY } from '../constants/typography';
import AppText from './AppText';

/**
 * Labelled text input.
 *
 * `tracked` widens letter spacing and forces uppercase entry — used for the
 * employee ID, which is a code rather than a word. It is read back character by
 * character, so it is set like a code.
 *
 * `iconAction` renders an icon button inside the field at its trailing edge —
 * the eye that reveals a password. It is icon-only because the control repeats
 * on every password field and a word there competes with the label for
 * attention; `accessibilityLabel` is what names the action. The input flexes
 * beside it, so typed text stops at the icon rather than running under it.
 */
const TextField = React.forwardRef(function TextField(
  { label, iconAction, hint, error, tracked = false, style, inputStyle, ...props },
  ref
) {
  const [focused, setFocused] = React.useState(false);

  const borderColor = error ? COLORS.error : focused ? COLORS.primary : COLORS.border;

  return (
    <View style={style}>
      <AppText weight="bold" size="xs" color={COLORS.textSecondary} style={styles.label}>
        {label}
      </AppText>

      <View
        style={[
          styles.shell,
          { borderColor },
          focused && styles.shellFocused,
          error && styles.shellError,
          props.editable === false && styles.shellDisabled,
        ]}
      >
        <TextInput
          ref={ref}
          // Code styling applies to typed content only. A placeholder is a
          // sentence, and bold letter-spaced prose reads as broken.
          style={[styles.input, tracked && props.value ? styles.inputTracked : null, inputStyle]}
          placeholderTextColor={COLORS.textMuted}
          selectionColor={COLORS.primary}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          autoCapitalize={tracked ? 'characters' : 'none'}
          autoCorrect={false}
          spellCheck={false}
          accessibilityLabel={label}
          {...props}
        />

        {iconAction ? (
          <TouchableOpacity
            onPress={iconAction.onPress}
            disabled={props.editable === false}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            accessibilityRole="button"
            accessibilityLabel={iconAction.accessibilityLabel}
            accessibilityState={{ selected: !!iconAction.active }}
            style={styles.iconButton}
          >
            <MaterialCommunityIcons
              name={iconAction.icon}
              size={22}
              // Lit while the state it toggles is on, so the eye reads as a
              // switch rather than as decoration.
              color={iconAction.active ? COLORS.primary : COLORS.textMuted}
            />
          </TouchableOpacity>
        ) : null}
      </View>

      {hint && !error ? (
        <AppText size="xs" color={COLORS.textMuted} style={styles.hint}>
          {hint}
        </AppText>
      ) : null}

      {error ? (
        <AppText size="xs" color={COLORS.errorDark} style={styles.hint} accessibilityLiveRegion="polite">
          {error}
        </AppText>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  label: { letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 8 },
  iconButton: { paddingLeft: 12, paddingVertical: 8 },
  shell: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surface,
    borderWidth: 1.5,
    borderRadius: 12,
    paddingHorizontal: 16,
    // Tall enough to hit reliably one-handed, outdoors, in a hurry.
    minHeight: 56,
  },
  shellFocused: {
    // Doubles as the visible focus indicator for keyboard users on web.
    shadowColor: COLORS.primary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.16,
    shadowRadius: 5,
    elevation: 2,
  },
  shellError: { backgroundColor: COLORS.errorLight },
  shellDisabled: { backgroundColor: COLORS.divider },
  input: {
    flex: 1,
    paddingVertical: 15,
    fontFamily: TYPOGRAPHY.fontFamily.medium,
    fontSize: TYPOGRAPHY.size.md,
    color: COLORS.text,
    // Removes the browser's own focus ring; the shell renders its own, so
    // without this web shows two.
    ...Platform.select({ web: { outlineStyle: 'none' } }),
  },
  inputTracked: { letterSpacing: 2, fontFamily: TYPOGRAPHY.fontFamily.bold },
  hint: { marginTop: 7, lineHeight: 16 },
});

export default TextField;
