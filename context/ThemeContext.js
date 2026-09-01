import React from 'react';
import { useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LIGHT_COLORS, DARK_COLORS } from '../constants/colors';

const STORAGE_KEY = 'kl.theme.preference';

const ThemeContext = React.createContext(null);

export function useTheme() {
  const ctx = React.useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}

/**
 * The one thing almost every screen actually needs — the live palette,
 * recomputed whenever the preference or the device's own scheme changes.
 * Every screen's `StyleSheet.create` is built from this rather than from the
 * static `COLORS` export, which is what makes a theme switch repaint
 * something already on screen instead of only the next screen opened.
 */
export function useThemeColors() {
  return useTheme().colors;
}

/**
 * Three states, not two. "System" is the default because it is the choice
 * that is right without anyone having made it — a phone already carries its
 * owner's own light/dark preference, set for every other app they use, and
 * defaulting to "Light" would silently override that for this one app alone.
 *
 * Persisted so the choice survives a restart; read once at launch rather than
 * gating the first frame on it, because a stored preference arriving one
 * render late is invisible and a blank frame while `AsyncStorage` answers is
 * not.
 */
export function ThemeProvider({ children }) {
  const systemScheme = useColorScheme();
  const [preference, setPreference] = React.useState('system');

  React.useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((stored) => {
        if (stored === 'light' || stored === 'dark' || stored === 'system') {
          setPreference(stored);
        }
      })
      .catch(() => {});
  }, []);

  const setTheme = React.useCallback((next) => {
    setPreference(next);
    AsyncStorage.setItem(STORAGE_KEY, next).catch(() => {});
  }, []);

  const resolved = preference === 'system' ? (systemScheme === 'dark' ? 'dark' : 'light') : preference;
  const colors = resolved === 'dark' ? DARK_COLORS : LIGHT_COLORS;

  const value = React.useMemo(
    () => ({ preference, resolved, colors, setTheme }),
    [preference, resolved, colors, setTheme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
