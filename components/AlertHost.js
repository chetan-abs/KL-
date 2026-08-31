import React from 'react';
import { Modal, View, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { COLORS } from '../constants/colors';
import { TYPOGRAPHY } from '../constants/typography';
import AppText from './AppText';
import { _subscribeAlertHost } from '../services/confirm';

/**
 * Renders showAlert(), confirmAction() and promptText() as styled in-app
 * dialogs.
 *
 * Mounted once at the app root. This is why those three can be called from an
 * axios interceptor or any other code outside the React tree — they publish to a
 * module-level listener and this subscribes to it.
 *
 * It exists at all because `react-native-web` implements Alert.alert as an empty
 * function: on the web build a confirm dialog never appeared, and the
 * destructive action inside its callback never ran.
 */
export default function AlertHost() {
  const [dialog, setDialog] = React.useState(null);
  const [text, setText] = React.useState('');

  React.useEffect(
    () =>
      _subscribeAlertHost((next) => {
        // Cleared per dialog rather than on close, so a reason typed into one
        // prompt cannot be pre-filled into the next.
        setText('');
        setDialog(next);
      }),
    []
  );

  if (!dialog) return null;

  const isConfirm = dialog.type === 'confirm';
  const isPrompt = dialog.type === 'prompt';
  const close = () => setDialog(null);

  const onPrimary = () => {
    const { onConfirm, onSubmit } = dialog;
    const value = text;
    close();
    if (isPrompt) onSubmit?.(value);
    else if (isConfirm) onConfirm?.();
  };

  // A prompt with nothing typed cannot be submitted: the server refuses an empty
  // reason anyway, and failing here says so before the round trip.
  const blocked = isPrompt && !text.trim();

  return (
    <Modal visible transparent animationType="fade" onRequestClose={close}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          {!!dialog.title && (
            <AppText weight="bold" size="lg" color={COLORS.text} style={styles.title}>
              {dialog.title}
            </AppText>
          )}
          {!!dialog.message && (
            <AppText size="sm" color={COLORS.textSecondary} style={styles.message}>
              {dialog.message}
            </AppText>
          )}

          {isPrompt && (
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder={dialog.placeholder}
              placeholderTextColor={COLORS.textMuted}
              style={styles.input}
              autoFocus
              onSubmitEditing={() => !blocked && onPrimary()}
              returnKeyType="done"
            />
          )}

          <View style={styles.actions}>
            {(isConfirm || isPrompt) && (
              <TouchableOpacity style={styles.btnGhost} onPress={close} activeOpacity={0.8}>
                <AppText weight="bold" size="sm" color={COLORS.textSecondary}>Cancel</AppText>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={[
                styles.btn,
                dialog.destructive && styles.btnDestructive,
                blocked && styles.btnInert,
              ]}
              onPress={onPrimary}
              disabled={blocked}
              activeOpacity={0.85}
            >
              <AppText weight="bold" size="sm" color={blocked ? COLORS.disabledText : COLORS.white}>
                {isPrompt ? dialog.confirmLabel : isConfirm ? 'Confirm' : 'OK'}
              </AppText>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: COLORS.white,
    borderRadius: 18,
    padding: 24,
    elevation: 12,
    shadowColor: COLORS.black,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.2,
    shadowRadius: 16,
  },
  title: { marginBottom: 6 },
  message: { marginBottom: 18, lineHeight: 20 },
  input: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 9,
    paddingHorizontal: 13,
    paddingVertical: 11,
    minHeight: 46,
    marginBottom: 18,
    color: COLORS.text,
    fontFamily: TYPOGRAPHY.fontFamily.regular,
    fontSize: TYPOGRAPHY.size.md,
    outlineStyle: 'none',
  },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
  btnGhost: {
    paddingVertical: 11,
    paddingHorizontal: 18,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: COLORS.border,
  },
  btn: { paddingVertical: 11, paddingHorizontal: 22, borderRadius: 10, backgroundColor: COLORS.primary },
  btnDestructive: { backgroundColor: COLORS.actionReject },
  btnInert: { backgroundColor: COLORS.disabled },
});
