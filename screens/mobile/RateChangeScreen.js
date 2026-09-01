import React from 'react';
import { View, RefreshControl, StyleSheet } from 'react-native';

import { useThemeColors } from '../../context/ThemeContext';
import { Items } from '../../services/endpoints';
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

/**
 * Rate-change approvals — R-11.
 *
 * "No rate or discount adjustment can be applied without approval from Yash or
 * Manoj." Gaurav proposes; this is where the proposal waits.
 *
 * Two things the screen is careful about:
 *
 * Every changed field is listed with its old and new value, because a batch is
 * approved as a whole and "the rates changed" is not something anybody can
 * consent to. Six discount columns move independently, and the one that matters
 * is rarely the one named in the reason.
 *
 * The value shown as "from" is what the column held when the request was made.
 * The server deliberately applies from whatever it holds *now* and records the
 * difference, so an old request approved today does not silently revert a rate
 * that moved in between. That is worth saying on screen rather than leaving to
 * be discovered.
 */

/**
 * The rate-card columns of `RATE_WRITABLE` in `backend/routes/items.js`, named
 * as the rate sheet names them. A raw column name in an approval queue is the
 * fastest way to approve the wrong discount.
 */
const FIELD_LABELS = {
  pricing_type: 'Pricing type',
  base_price: 'Base price',
  cost_price: 'Cost price',
  disc_dealer: 'Dealer discount',
  disc_builder_direct: 'Builder direct discount',
  disc_builder_comm: 'Builder (through agent) discount',
  disc_retail_direct: 'Retail direct discount',
  disc_retail_comm: 'Retail (through agent) discount',
  disc_electrician: 'Electrician discount',
  ratio_builder_direct: 'Builder direct markup',
  ratio_builder_comm: 'Builder (through agent) markup',
  ratio_retail_direct: 'Retail direct markup',
  ratio_retail_comm: 'Retail (through agent) markup',
  ratio_electrician: 'Electrician markup',
  comm_retail_agent: 'Retail agent commission',
  comm_builder_agent: 'Builder agent commission',
  scheme_weightage: 'Scheme weightage',
};

const TABS = [
  ['pending', 'Waiting'],
  ['approved', 'Approved'],
  ['rejected', 'Rejected'],
  ['superseded', 'Superseded'],
];

export default function RateChangeScreen({ role, nav, onBack }) {
  const COLORS = useThemeColors();
  const styles = React.useMemo(() => StyleSheet.create({
  tabs: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  badges: { flexDirection: 'row', gap: 6, alignItems: 'center' },
  reason: { marginTop: 8 },
  changes: { marginTop: 12, gap: 8 },
  change: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  fieldName: { flex: 1 },
  from: { textDecorationLine: 'line-through' },
  actions: { flexDirection: 'row', gap: 8, marginTop: 14 },
}), [COLORS]);
  const [status, setStatus] = React.useState('pending');

  const { data, loading, error, refreshing, reload, refresh } = useApi(
    () => Items.rateChanges(status),
    [status]
  );

  const decide = useAction(
    ({ batch, approve, note }) => Items.decideRateChange(batch, approve, note),
    { onDone: reload }
  );

  const batches = data?.batches || [];
  // The server is the judge; this only decides whether to draw the controls.
  // 3.2 tiers the requirement itself — a batch needing only Sibu's sign-off
  // (`can_decide`) is not the same as one that needs an owner, so each batch
  // carries its own answer rather than one screen-wide flag.
  const canApprove = data?.can_approve === true;
  const canApproveAny = canApprove || data?.can_approve_variance === true;

  const TIER_LABEL = { auto: 'Auto', sibu: 'Sibu', owner: 'Owner only' };
  const TIER_TONE = { auto: 'success', sibu: 'pending', owner: 'danger' };

  const askApprove = (batch) => confirmAction(
    `Approve ${batch.changes.length} change${batch.changes.length > 1 ? 's' : ''}?`,
    `${batch.item_name} — proposed by ${batch.requested_by || 'someone'}. `
    + 'Every order priced after this uses the new figures.',
    () => decide.run({ batch: batch.batch_ref, approve: true })
  );

  /**
   * A rejection takes a reason. The proposer is notified with it, and "no"
   * without one sends them back to guess which of six columns was wrong.
   */
  const askReject = (batch) => promptText({
    title: 'Reject this change?',
    message: `${batch.item_name} — ${batch.changes.length} field(s).`,
    placeholder: 'Why?',
    confirmLabel: 'Reject',
    destructive: true,
    onSubmit: (note) => decide.run({ batch: batch.batch_ref, approve: false, note }),
  });

  return (
    <Screen
      header={
        <ScreenHeader
          clock=""
          role={role.name}
          title="Rate Changes"
          subtitle={status === 'pending' ? 'awaiting approval' : status}
          badge={`${batches.length}`}
          badgeTone={status === 'pending' && batches.length ? 'pending' : 'neutral'}
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

      {status === 'pending' && !canApproveAny && batches.length ? (
        <NoticeBar tone="info">
          You can see what is waiting, but only Sibu or an owner may decide it (3.2 / R-11).
        </NoticeBar>
      ) : null}

      <AsyncBoundary
        loading={loading}
        error={error}
        onRetry={reload}
        empty={!batches.length}
        emptyGlyph="₹"
        emptyText={status === 'pending' ? 'No rate changes are waiting.' : `Nothing ${status}.`}
      >
        {batches.map((batch) => (
          <Card
            key={batch.batch_ref || `single-${batch.item_id}`}
            title={batch.item_name}
            right={
              <View style={styles.badges}>
                {status === 'pending' ? (
                  <Badge tone={TIER_TONE[batch.tier] || 'neutral'}>
                    {TIER_LABEL[batch.tier] || batch.tier}
                  </Badge>
                ) : null}
                <Badge tone={status === 'pending' ? 'pending' : 'neutral'}>
                  {`${batch.changes.length} field${batch.changes.length > 1 ? 's' : ''}`}
                </Badge>
              </View>
            }
          >
            <AppText size="xs" color={COLORS.textMuted}>
              {[
                batch.requested_by ? `Proposed by ${batch.requested_by}` : null,
                relativeTime(batch.requested_at),
              ].filter(Boolean).join(' · ')}
            </AppText>

            {batch.reason ? (
              <AppText size="sm" style={styles.reason}>{batch.reason}</AppText>
            ) : null}

            <View style={styles.changes}>
              {batch.changes.map((change) => (
                <View key={change.id} style={styles.change}>
                  <AppText size="xs" color={COLORS.textSecondary} style={styles.fieldName}>
                    {FIELD_LABELS[change.field] || change.field}
                  </AppText>
                  <AppText size="sm" color={COLORS.textMuted} style={styles.from}>
                    {change.from ?? '—'}
                  </AppText>
                  <AppText size="sm" color={COLORS.textMuted}>→</AppText>
                  <AppText weight="bold" size="sm">{change.to ?? '—'}</AppText>
                  {change.variance_percent !== null && change.variance_percent !== undefined ? (
                    <AppText size="xs" color={COLORS.textMuted}>{`${change.variance_percent}% below`}</AppText>
                  ) : null}
                </View>
              ))}
            </View>

            {status === 'pending' && batch.can_decide ? (
              <View style={styles.actions}>
                <ActionButton
                  tone="approve"
                  size="sm"
                  label="Approve"
                  disabled={decide.busy}
                  onPress={() => askApprove(batch)}
                />
                <ActionButton
                  tone="reject"
                  size="sm"
                  label="Reject"
                  disabled={decide.busy}
                  onPress={() => askReject(batch)}
                />
              </View>
            ) : null}
          </Card>
        ))}

        {status === 'pending' && batches.length ? (
          <NoticeBar tone="info">
            The "from" figures are what the item held when the change was
            proposed. Approving applies the new value against whatever it holds
            now, and the difference is recorded — an old request cannot silently
            undo a rate that moved since.
          </NoticeBar>
        ) : null}

        {decide.error ? <NoticeBar tone="danger">{decide.error}</NoticeBar> : null}
      </AsyncBoundary>
    </Screen>
  );
}

