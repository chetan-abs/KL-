import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import api, { setAuthToken, setUnauthorizedHandler, describeError } from '../services/api';

const TOKEN_KEY = 'kl.auth.token';

const AuthContext = React.createContext(null);

export function useAuth() {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/**
 * Session state for the whole app.
 *
 * `status` drives what the navigator shows:
 *   'restoring' — reading storage; nothing user-facing has been decided yet
 *   'signedOut' — show the sign-in screen
 *   'signedIn'  — show the app
 */
export function AuthProvider({ children }) {
  const [status, setStatus] = React.useState('restoring');
  const [user, setUser] = React.useState(null);

  const signOut = React.useCallback(async () => {
    setAuthToken(null);
    setUser(null);
    setStatus('signedOut');
    await AsyncStorage.removeItem(TOKEN_KEY).catch(() => {});
  }, []);

  // A stored token is not trusted on its face. It is sent to /me, and only a
  // successful round trip signs the user in — so a token that expired while the
  // app was closed, or belongs to an account since deactivated, lands on the
  // sign-in screen instead of a broken session inside the app.
  React.useEffect(() => {
    let cancelled = false;

    (async () => {
      const stored = await AsyncStorage.getItem(TOKEN_KEY).catch(() => null);
      if (!stored) {
        if (!cancelled) setStatus('signedOut');
        return;
      }

      setAuthToken(stored);
      try {
        const { data } = await api.get('/auth/me');
        if (cancelled) return;
        setUser(data.user);
        setStatus('signedIn');
      } catch {
        if (cancelled) return;
        setAuthToken(null);
        await AsyncStorage.removeItem(TOKEN_KEY).catch(() => {});
        setStatus('signedOut');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Lets the axios interceptor end the session when the server rejects a token
  // mid-flight, without that request knowing anything about React.
  React.useEffect(() => setUnauthorizedHandler(() => signOut()), [signOut]);

  /**
   * Resolves to { ok: true } or { ok: false, message } rather than throwing.
   * The sign-in form needs to render the failure inline, and a rejected promise
   * would make every caller write the same try/catch to get there.
   */
  const signIn = React.useCallback(async (id, password) => {
    try {
      const { data } = await api.post('/auth/login', { id, password });
      setAuthToken(data.token);
      await AsyncStorage.setItem(TOKEN_KEY, data.token).catch(() => {});
      setUser(data.user);
      setStatus('signedIn');
      return { ok: true };
    } catch (error) {
      return { ok: false, message: describeError(error) };
    }
  }, []);

  /**
   * Cleared by the change-password screen once the server has accepted the new
   * one. Kept on the context rather than re-fetched, because the navigator has
   * to decide what to render on the very first frame after the change and a
   * round trip would flash the login gate in between.
   */
  const clearPasswordChange = React.useCallback(() => {
    setUser((prev) => (prev ? { ...prev, must_change_password: false } : prev));
  }, []);

  /**
   * `must_change_password` comes back on the user from both /auth/login and
   * /auth/me, so a session restored from a stored token lands on the same gate
   * as a fresh sign-in. Reading it off `user` rather than holding a second copy
   * means there is one answer to "does this account still owe a password", and
   * it is the server's.
   */
  const value = React.useMemo(
    () => ({
      status,
      user,
      signIn,
      signOut,
      mustChangePassword: !!user?.must_change_password,
      clearPasswordChange,
    }),
    [status, user, signIn, signOut, clearPasswordChange]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
