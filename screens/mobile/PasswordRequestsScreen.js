import React from 'react';
import { View, RefreshControl, StyleSheet } from 'react-native';

import { COLORS } from '../../constants/colors';
import { Users } from '../../services/endpoints';
import { useApi, useAction } from '../../hooks/useApi';
import { relativeTime } from '../../utils/datetime';
import { promptText, confirmAction } from '../../services/confirm';
import AppText from '../../components/AppText';
import Screen from '../../components/mobile/Screen';
import ScreenHeader from '../../components/mobile/ScreenHeader';
import Card from '../../components/mobile/Card';
import Badge from '../../components/mobile/Badge';
import NoticeBar from '../../components/mobile/NoticeBar';
import ActionButton from '../../components/mobile/ActionButton';
import AsyncBoundary from '../../components/mobile/AsyncBoundary';

const TABS = [
  ['pending', 'Waiting'],
  ['approved', 'Approved'],
  ['rejected', 'Rejected'],
];

/**
 * The password-change approval queue (migration 016). The same shape R-11's
 * rate-change queue uses: Yash or Manoj is the only decision that matters,
 * and the route itself re-checks the grant — this screen only decides
 * whether the buttons are drawn.
 */
export default function PasswordRequestsScreen({ role, nav, onBack }) {
  const [status, setStatus] = React.useState('pending');
  const { data, loading, error, refreshing, reload, refresh } = useApi(
    () => Users.passwordRequests(status),
    [status]
  );
  const requests = data?.requests || [];

  const decide = useAction(
    ({ id, approve, note }) => Users.decidePasswordRequest(id, approve, note),
    { onDone: reload }
  );

  const askApprove = (r) => confirmAction(
    `Approve ${r.employee_name}'s password change?`,
    'Their new password becomes active immediately.',
    () => decide.run({ id: r.id, approve: true })
  );

  const askReject = (r) => promptText({
    title: 'Decline this change?',
    message: `${r.employee_name} will be told it was declined.`,
    placeholder: 'Why? (optional)',
    confirmLabel: 'Decline',
    destructive: true,
    onSubmit: (note) => decide.run({ id: r.id, approve: false, note }),
  });

  return (
    <Screen
      header={
        <ScreenHeader
          role={role.name}
          title="Password Requests"
          subtitle={status === 'pending' ? 'awaiting approval' : status}
          badge={`${requests.length}`}
          badgeTone={status === 'pending' && requests.length ? 'pending' : 'neutral'}
          onBack={onBack}
        />
      }
      nav={nav}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={COLORS.brand} />
      }
    >
      <View style={styles.tabs}>
        {TABS.map(([key, label]) => (
          <ActionButton
            key={key}
            tone={status === key ? 'brand' : 'neutral'}
            size="sm"
            label={label}
            onPress={() => setStatus(key)}
          />
        ))}
      </View>

      <AsyncBoundary
        loading={loading}
        error={error}
        onRetry={reload}
        empty={!requests.length}
        emptyGlyph="🔑"
        emptyText={status === 'pending' ? 'No password changes are waiting.' : `Nothing ${status}.`}
      >
        {requests.map((r) => (
          <Card
            key={r.id}
            title={r.employee_name}
            right={<Badge tone={status === 'pending' ? 'pending' : 'neutral'}>{r.employee_id}</Badge>}
          >
            <AppText size="xs" color={COLORS.textMuted}>{relativeTime(r.requested_at)}</AppText>

            {r.decision_note ? (
              <AppText size="sm" style={styles.note}>{r.decision_note}</AppText>
            ) : null}

            {status === 'pending' ? (
              <View style={styles.actions}>
                <ActionButton
                  tone="approve"
                  size="sm"
                  label="Approve"
                  disabled={decide.busy}
                  onPress={() => askApprove(r)}
                />
                <ActionButton
                  tone="reject"
                  size="sm"
                  label="Decline"
                  disabled={decide.busy}
                  onPress={() => askReject(r)}
                />
              </View>
            ) : null}
          </Card>
        ))}

        {decide.error ? <NoticeBar tone="danger">{decide.error}</NoticeBar> : null}
      </AsyncBoundary>
    </Screen>
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  note: { marginTop: 8 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 14 },
});
