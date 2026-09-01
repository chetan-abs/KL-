import React from 'react';
import { View, TouchableOpacity, StyleSheet } from 'react-native';

import { useThemeColors } from '../../context/ThemeContext';
import { WILDCARD } from '../../constants/permissions';
import { userCan } from '../../utils/permissions';
import { API_BASE_URL } from '../../services/api';
import { confirmAction } from '../../services/confirm';
import AppText from '../../components/AppText';
import Screen from '../../components/mobile/Screen';
import ScreenHeader from '../../components/mobile/ScreenHeader';
import Card from '../../components/mobile/Card';
import DetailRow from '../../components/mobile/DetailRow';
import Avatar from '../../components/mobile/Avatar';
import Badge from '../../components/mobile/Badge';
import ActionButton from '../../components/mobile/ActionButton';

/**
 * The account screen every role carries.
 *
 * Sign-out lives here and only here, and it confirms first: on a shared shop
 * phone an accidental sign-out during a delivery run means finding someone who
 * knows the password before the next stop can be closed.
 *
 * The grants are listed rather than summarised, because "what am I allowed to
 * do" is the question this screen exists to answer when a screen is missing from
 * somebody's tab bar.
 */
export default function ProfileScreen({
  role, user, nav, onSignOut, onOpenPeople,
  onOpenSalary, onOpenAdvances, onOpenIncentive, onOpenAttendance,
  onOpenChangePassword, onOpenPasswordRequests,
}) {
  const COLORS = useThemeColors();
  const styles = React.useMemo(() => StyleSheet.create({
    flex: { flex: 1 },
    linkRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingVertical: 13,
      paddingHorizontal: 14,
    },
    ruled: { borderBottomWidth: 1, borderBottomColor: COLORS.borderLight },
    identity: { flexDirection: 'row', alignItems: 'center' },
    identityText: { marginLeft: 14 },
    grants: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    link: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    meta: { marginTop: 3 },
  }), [COLORS]);

  const granted = React.useMemo(() => {
    if (!user?.permissions) return [];
    return Array.isArray(user.permissions) ? user.permissions : JSON.parse(user.permissions || '[]');
  }, [user]);

  const wildcard = granted.includes(WILDCARD);
  const canManagePeople = userCan(user, 'employees.permissions');

  return (
    <Screen
      header={<ScreenHeader clock="" role={role.name} title="Profile" subtitle={role.title} />}
      nav={nav}
      footer={
        <ActionButton
          label="Sign out"
          tone="reject"
          onPress={() =>
            confirmAction('Sign out?', 'You will need your password to get back in.', onSignOut)
          }
        />
      }
    >
      <Card>
        <View style={styles.identity}>
          <Avatar name={user?.name || role.name} size={58} />
          <View style={styles.identityText}>
            <AppText weight="bold" size="lg">{user?.name || role.name}</AppText>
            <AppText size="sm" color={COLORS.textSecondary}>{role.title}</AppText>
          </View>
        </View>
      </Card>

      <Card title="Account" flush>
        <DetailRow label="Username" value={user?.id} />
        <DetailRow label="Email" value={user?.email || '—'} />
        <DetailRow label="Branch" value="Lakhtokia, Guwahati" last />
      </Card>

      <Card title={`What you can do (${wildcard ? 'everything' : granted.length})`}>
        {wildcard ? (
          <AppText size="sm" color={COLORS.textSecondary}>
            Full access. Every screen and every action is open to this account.
          </AppText>
        ) : granted.length ? (
          <View style={styles.grants}>
            {granted.map((grant) => (
              <Badge key={grant} tone="neutral">{grant}</Badge>
            ))}
          </View>
        ) : (
          <AppText size="sm" color={COLORS.textSecondary}>
            No grants. Only your own alerts, route and beat are visible — those are scoped to you and
            need no permission.
          </AppText>
        )}
      </Card>

      {/* Section 6 — every role's own check-in, lunch and check-out. Not a tab
          for the same reason pay is not: the bar holds five slots and every one
          is already a duty somebody does all day. This one *is* daily, but it
          is a single glance-and-tap rather than something left open, so it
          costs a screen push rather than a slot. */}
      <Card title="Attendance" flush>
        <LinkRow
          title="Check in / check out"
          subtitle="Today's status, lunch break, and the day's photo"
          onPress={onOpenAttendance}
          last
        />
      </Card>

      {/* Everybody's own pay — except an owner, who draws none. Yash and
          Manoj are proprietors, not salaried staff: there is no fixed_salary
          row meant for them, and a Salary screen open on an owner would show
          either someone else's figures or a meaningless ₹0 ledger. Advances
          and leave stay on the card for an owner too, but as the register and
          approve view rather than a request form — see AdvancesScreen. */}
      <Card title={role.isOwner ? 'Payroll' : 'Your pay'} flush>
        {!role.isOwner ? (
          <LinkRow
            title="Salary"
            subtitle="This month's ledger, its deductions and the slip"
            onPress={onOpenSalary}
          />
        ) : null}
        <LinkRow
          title="Advances & leave"
          subtitle={
            role.isOwner
              ? "See who's taken an advance or applied for leave, and decide it"
              : 'Request an advance, apply for leave'
          }
          onPress={onOpenAdvances}
          last={role.isOwner}
        />
        {!role.isOwner ? (
          <LinkRow
            title="Incentive"
            subtitle="Progress against the twenty segments"
            onPress={onOpenIncentive}
            last
          />
        ) : null}
      </Card>

      {canManagePeople ? (
        <TouchableOpacity onPress={onOpenPeople} activeOpacity={0.75} accessibilityRole="button">
          <Card>
            <View style={styles.link}>
              <View style={styles.flex}>
                <AppText weight="bold" size="sm">People & access</AppText>
                <AppText size="xs" color={COLORS.textSecondary} style={styles.meta}>
                  Grant or revoke what staff can do
                </AppText>
              </View>
              <AppText size="md" color={COLORS.primary}>→</AppText>
            </View>
          </Card>
        </TouchableOpacity>
      ) : null}

      <Card title="Security" flush>
        <DetailRow label="Session" value="Expires 12h after sign-in" tone="muted" />
        <DetailRow label="Server" value={API_BASE_URL} tone="muted" last />
      </Card>

      {canManagePeople && onOpenPasswordRequests ? (
        <TouchableOpacity onPress={onOpenPasswordRequests} activeOpacity={0.75} accessibilityRole="button">
          <Card>
            <View style={styles.link}>
              <View style={styles.flex}>
                <AppText weight="bold" size="sm">Password requests</AppText>
                <AppText size="xs" color={COLORS.textSecondary} style={styles.meta}>
                  Approve or decline what staff want to change theirs to
                </AppText>
              </View>
              <AppText size="md" color={COLORS.primary}>→</AppText>
            </View>
          </Card>
        </TouchableOpacity>
      ) : null}

      <ActionButton
        label="Change password"
        tone="neutral"
        onPress={onOpenChangePassword}
      />
    </Screen>
  );
}

/** A tappable row inside a flush Card — the same shape as `DetailRow`, but a link. */
function LinkRow({ title, subtitle, onPress, last = false }) {
  const COLORS = useThemeColors();
  const styles = React.useMemo(() => StyleSheet.create({
    linkRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingVertical: 13,
      paddingHorizontal: 14,
    },
    ruled: { borderBottomWidth: 1, borderBottomColor: COLORS.borderLight },
    flex: { flex: 1 },
    meta: { marginTop: 3 },
  }), [COLORS]);

  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.75} accessibilityRole="button">
      <View style={[styles.linkRow, last ? null : styles.ruled]}>
        <View style={styles.flex}>
          <AppText weight="bold" size="sm">{title}</AppText>
          <AppText size="xs" color={COLORS.textSecondary} style={styles.meta}>{subtitle}</AppText>
        </View>
        <AppText size="md" color={COLORS.primary}>→</AppText>
      </View>
    </TouchableOpacity>
  );
}
