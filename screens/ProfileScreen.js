import React from 'react';
import { View, StyleSheet, ScrollView } from 'react-native';
import { COLORS } from '../constants/colors';
import AppText from '../components/AppText';
import Button from '../components/Button';
import TextField from '../components/TextField';
import Notice from '../components/Notice';
import { useAuth } from '../context/AuthContext';
import api, { describeError } from '../services/api';
import { confirmAction, showAlert } from '../services/confirm';
import { checkPassword } from '../utils/password';

const EMPTY_FORM = { current_password: '', new_password: '', confirm: '' };

export default function ProfileScreen() {
  const { user, signOut } = useAuth();

  const [changing, setChanging] = React.useState(false);
  const [form, setForm] = React.useState(EMPTY_FORM);
  const [reveal, setReveal] = React.useState(false);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const handleSignOut = () => {
    confirmAction('Sign out', 'Are you sure you want to sign out?', signOut);
  };

  const set = (field) => (value) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    if (error) setError('');
  };

  /**
   * PATCH /auth/change-password has existed and worked since the auth slice was
   * written. The only screen that called it was components/WorkforcePages.js,
   * which nothing imported — so in practice nobody could change their password
   * without an administrator setting a new one for them.
   */
  const submitPassword = async () => {
    if (busy) return;

    const policyError = checkPassword(form.new_password);
    if (!form.current_password) {
      setError('Enter your current password.');
      return;
    }
    if (policyError) {
      setError(policyError);
      return;
    }
    if (form.new_password !== form.confirm) {
      setError('The new passwords do not match.');
      return;
    }
    if (form.new_password === form.current_password) {
      setError('The new password must be different from the current one.');
      return;
    }

    setBusy(true);
    try {
      await api.patch('/auth/change-password', {
        current_password: form.current_password,
        new_password: form.new_password,
      });
      setForm(EMPTY_FORM);
      setChanging(false);
      showAlert('Password changed', 'Use your new password the next time you sign in.');
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.profileHeader}>
          <View style={styles.avatarLarge}>
            <AppText weight="bold" size="xxl" color={COLORS.primary}>
              {user?.name ? user.name.charAt(0).toUpperCase() : 'U'}
            </AppText>
          </View>
          <AppText weight="bold" size="xl" color={COLORS.text} style={{ marginTop: 16 }}>
            {user?.name || 'Sales Representative'}
          </AppText>
          <AppText size="sm" color={COLORS.textSecondary}>
            {user?.role ? user.role.toUpperCase() : 'EMPLOYEE'} • ID: {user?.id}
          </AppText>
        </View>

        <View style={styles.detailsCard}>
          <View style={styles.detailRow}>
            <AppText size="xs" color={COLORS.textMuted}>Email Address</AppText>
            <AppText weight="bold" size="sm" color={COLORS.text}>{user?.email || 'N/A'}</AppText>
          </View>
          <View style={styles.detailRow}>
            <AppText size="xs" color={COLORS.textMuted}>Phone Number</AppText>
            <AppText weight="bold" size="sm" color={COLORS.text}>{user?.phone || 'N/A'}</AppText>
          </View>
          <View style={[styles.detailRow, { borderBottomWidth: 0 }]}>
            <AppText size="xs" color={COLORS.textMuted}>Region / Territory</AppText>
            <AppText weight="bold" size="sm" color={COLORS.text}>{user?.city || 'Unassigned'}</AppText>
          </View>
        </View>

        {changing ? (
          <View style={styles.detailsCard}>
            <AppText weight="bold" size="sm" color={COLORS.text} style={styles.formTitle}>
              Change password
            </AppText>

            <TextField
              label="Current password"
              value={form.current_password}
              onChangeText={set('current_password')}
              placeholder="Enter your current password"
              secureTextEntry={!reveal}
              editable={!busy}
              textContentType="password"
            />

            <TextField
              label="New password"
              style={styles.spaced}
              value={form.new_password}
              onChangeText={set('new_password')}
              placeholder="At least 8 characters"
              secureTextEntry={!reveal}
              editable={!busy}
              textContentType="newPassword"
              iconAction={{
                icon: reveal ? 'eye-off-outline' : 'eye-outline',
                accessibilityLabel: reveal ? 'Hide passwords' : 'Show passwords',
                active: reveal,
                onPress: () => setReveal((v) => !v),
              }}
            />

            <TextField
              label="Confirm new password"
              style={styles.spaced}
              value={form.confirm}
              onChangeText={set('confirm')}
              placeholder="Type it again"
              secureTextEntry={!reveal}
              editable={!busy}
              textContentType="newPassword"
              onSubmitEditing={submitPassword}
              returnKeyType="go"
            />

            {error ? <Notice tone="error" style={styles.spaced}>{error}</Notice> : null}

            <Button
              variant="brand"
              label="Save new password"
              loadingLabel="Saving"
              loading={busy}
              onPress={submitPassword}
              style={styles.spaced}
            />

            <Button
              variant="quiet"
              label="Cancel"
              disabled={busy}
              onPress={() => {
                setChanging(false);
                setForm(EMPTY_FORM);
                setError('');
              }}
              style={styles.spaced}
            />
          </View>
        ) : (
          <Button
            variant="quiet"
            label="Change password"
            onPress={() => setChanging(true)}
            style={styles.actionBtn}
          />
        )}

        <Button
          label="Sign Out"
          onPress={handleSignOut}
          style={styles.actionBtn}
        />

        <AppText size="xs" color={COLORS.textMuted} style={styles.footerText}>
          App Version 1.0.0 • Designed and Developed by ABS Technologies
        </AppText>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  content: { padding: 20, paddingBottom: 40 },
  profileHeader: { alignItems: 'center', marginBottom: 24 },
  avatarLarge: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: COLORS.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  detailsCard: {
    backgroundColor: COLORS.surface,
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: COLORS.border,
    marginBottom: 16,
  },
  detailRow: {
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.borderLight,
  },
  formTitle: { marginBottom: 16 },
  spaced: { marginTop: 16 },
  actionBtn: { marginTop: 12 },
  footerText: { marginTop: 24, textAlign: 'center' },
});
