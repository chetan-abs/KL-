import { Alert, Platform } from 'react-native';

// ── In-app alert host (web) ────────────────────────────────────────────────
// On web, the native window.alert/confirm look out of place. We route alerts
// through a global <AlertHost /> (mounted once at the app root) instead.
let _listener = null;
export function _subscribeAlertHost(fn) {
  _listener = fn;
  return () => { if (_listener === fn) _listener = null; };
}
function dispatch(payload) {
  if (_listener) { _listener(payload); return true; }
  return false;
}

export function confirmAction(title, message, onConfirm) {
  if (Platform.OS === 'web') {
    if (dispatch({ type: 'confirm', title, message, onConfirm })) return;
    if (window.confirm(`${title}\n${message}`)) onConfirm();   // fallback
  } else {
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Confirm', style: 'destructive', onPress: onConfirm },
    ]);
  }
}

export function showAlert(title, message) {
  if (Platform.OS === 'web') {
    if (dispatch({ type: 'alert', title, message })) return;
    window.alert(`${title}\n${message}`);   // fallback
  } else {
    Alert.alert(title, message);
  }
}

/**
 * Asks for a line of text before doing something.
 *
 * Several actions are refused by the server without a reason — rejecting an
 * order, failing a delivery, reversing a receipt — because a rejection nobody
 * can explain to the party is not much use. This is how that reason is
 * collected without giving each of them a screen.
 *
 * `onSubmit` is called with the trimmed text and only when there is some;
 * cancelling does nothing at all. On native this is Alert.prompt, which exists
 * only on iOS — Android falls through to the same in-app host the web uses, so
 * the behaviour is identical on every target that lacks it.
 */
export function promptText({
  title,
  message,
  placeholder = '',
  confirmLabel = 'Confirm',
  destructive = false,
  onSubmit,
}) {
  const submit = (value) => {
    const text = String(value || '').trim();
    if (text) onSubmit(text);
  };

  if (Platform.OS === 'ios') {
    Alert.prompt(title, message, [
      { text: 'Cancel', style: 'cancel' },
      { text: confirmLabel, style: destructive ? 'destructive' : 'default', onPress: submit },
    ], 'plain-text', '', 'default');
    return;
  }

  if (dispatch({ type: 'prompt', title, message, placeholder, confirmLabel, destructive, onSubmit: submit })) {
    return;
  }

  // No host mounted. window.prompt is the only remaining way to ask, and
  // returning without asking would silently drop the action.
  if (typeof window !== 'undefined' && window.prompt) {
    submit(window.prompt(`${title}\n${message || ''}`, ''));
  }
}
