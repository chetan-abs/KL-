import React from 'react';
import { View, RefreshControl, StyleSheet } from 'react-native';

import { COLORS } from '../../constants/colors';
import { Tally } from '../../services/endpoints';
import { useApi, useAction } from '../../hooks/useApi';
import { relativeTime } from '../../utils/datetime';
import { confirmAction, showAlert } from '../../services/confirm';
import AppText from '../../components/AppText';
import Screen from '../../components/mobile/Screen';
import ScreenHeader from '../../components/mobile/ScreenHeader';
import Card from '../../components/mobile/Card';
import Badge from '../../components/mobile/Badge';
import NoticeBar from '../../components/mobile/NoticeBar';
import ActionButton from '../../components/mobile/ActionButton';
import AsyncBoundary from '../../components/mobile/AsyncBoundary';

/**
 * Tally sync — section 14.
 *
 * The screen answers one question first: is it working? A sync that is quietly
 * off, or quietly failing, is worse than none — the books look synced and are
 * not — so the state is the headline and everything else is below it.
 *
 * "Unreachable" and "rejected" are shown as different things throughout,
 * because they need different people: unreachable is somebody turning Tally on,
 * rejected is somebody reading the error.
 */

const STATE_TONE = {
  pending: 'pending',
  sending: 'pending',
  sent: 'success',
  failed: 'danger',
  skipped: 'neutral',
};

export default function TallyScreen({ role, nav, onBack }) {
  const { data, loading, error, refreshing, reload, refresh } = useApi(() => Tally.status(), []);
  const queue = useApi(() => Tally.queue({ status: 'failed' }), []);

  const push = useAction(() => Tally.push(), {
    onDone: (r) => {
      reload();
      queue.reload();
      showAlert('Push finished',
        r.skipped ? 'The sync is switched off — nothing was attempted.'
          : r.reachable === false ? `Tally did not answer. ${r.note || ''}`
            : `${r.sent} sent, ${r.failed} failed.`);
    },
  });

  const retryAll = useAction(() => Tally.retryAll(), {
    onDone: () => { reload(); queue.reload(); },
  });

  const runDoctor = useAction(() => Tally.doctor(), {
    onDone: (r) => {
      const bad = (r.checks || []).filter((c) => !c.ok);
      showAlert(
        bad.length ? `${bad.length} check(s) failed` : 'All checks passed',
        bad.length
          ? bad.map((c) => `• ${c.name}\n  ${c.fix || c.detail}`).join('\n\n')
          : 'Tally is reachable, the company matches and the posting ledgers exist.'
      );
    },
  });

  const pull = useAction(() => Tally.pull('all'), {
    onDone: (r) => showAlert('Pull finished', JSON.stringify(r, null, 1).slice(0, 400)),
  });

  const cfg = data?.configuration || {};
  const q = data?.queue || {};
  const stuck = data?.stuck || [];
  const waiting = (q.pending || 0) + (q.failed || 0);

  const askPull = () => confirmAction(
    'Pull the masters from Tally?',
    'This imports 7,000+ parties and 7,300+ items. Stock levels and balances are '
    + 'compared, never overwritten — a difference becomes a variance to resolve.',
    pull.run
  );

  return (
    <Screen
      header={
        <ScreenHeader
          clock=""
          role={role.name}
          title="Tally Sync"
          subtitle={cfg.company || 'no company configured'}
          badge={cfg.enabled ? (data?.health?.reachable ? 'LIVE' : 'UNREACHABLE') : 'OFF'}
          badgeTone={cfg.enabled ? (data?.health?.reachable ? 'success' : 'danger') : 'neutral'}
          onBack={onBack}
        />
      }
      nav={nav}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={COLORS.brand} />
      }
      footer={
        <>
          <ActionButton
            label={push.busy ? 'Pushing…' : `Push now${waiting ? ` (${waiting})` : ''}`}
            onPress={push.run}
            disabled={push.busy}
          />
          <ActionButton
            tone="neutral"
            label={runDoctor.busy ? 'Checking…' : 'Run the preflight'}
            onPress={runDoctor.run}
            disabled={runDoctor.busy}
          />
        </>
      }
    >
      <AsyncBoundary loading={loading} error={error} onRetry={reload}>
        {/* The state, said plainly. A sync that is off and looks on is the
            worst possible state for an accounting integration. */}
        {cfg.note ? (
          <NoticeBar tone={cfg.enabled ? 'warning' : 'info'}>{cfg.note}</NoticeBar>
        ) : null}

        {cfg.enabled && data?.health && !data.health.reachable ? (
          <NoticeBar tone="danger">
            {`Tally is not answering at ${cfg.host}. ${data.health.note || ''} `
              + 'Documents are still queued — nothing is lost.'}
          </NoticeBar>
        ) : null}

        <Card title="The outbox">
          <View style={styles.counts}>
            <Count label="Waiting" value={q.pending} tone={q.pending ? COLORS.warning : null} />
            <Count label="Sent" value={q.sent} tone={COLORS.success} />
            <Count label="Failed" value={q.failed} tone={q.failed ? COLORS.error : null} />
            <Count label="Skipped" value={q.skipped} />
          </View>
          <AppText size="xs" color={COLORS.textMuted} style={styles.note}>
            Every invoice, receipt and voucher is queued the moment it happens and
            sent when Tally is reachable. Nothing is lost while it is closed.
          </AppText>
        </Card>

        {Number(data?.unresolved_variances) > 0 ? (
          <NoticeBar tone="warning">
            {`${data.unresolved_variances} stock or balance figure${
              data.unresolved_variances > 1 ? 's disagree' : ' disagrees'} with Tally. `
              + 'Neither side was overwritten — open the reconciliation to resolve.'}
          </NoticeBar>
        ) : null}

        {stuck.length ? (
          <Card
            title={`Stuck (${stuck.length})`}
            flush
            right={
              <ActionButton
                tone="neutral"
                size="sm"
                label={retryAll.busy ? 'Retrying…' : 'Retry all'}
                onPress={retryAll.run}
                disabled={retryAll.busy}
              />
            }
          >
            {stuck.map((row, index) => (
              <View key={row.id} style={[styles.row, index ? styles.ruled : null]}>
                <View style={styles.body}>
                  <AppText weight="bold" size="sm">
                    {`${row.kind.replace(/_/g, ' ')} · ${row.ref_type} #${row.ref_id}`}
                  </AppText>
                  <AppText size="xs" color={COLORS.error} style={styles.meta} numberOfLines={3}>
                    {row.last_error || 'no reason recorded'}
                  </AppText>
                </View>
                <Badge tone="danger">{`${row.attempts}×`}</Badge>
              </View>
            ))}
          </Card>
        ) : null}

        <Card title="Recent runs" flush>
          {(data?.recent_runs || []).slice(0, 6).map((run, index) => (
            <View key={run.started_at + index} style={[styles.row, index ? styles.ruled : null]}>
              <View style={styles.body}>
                <AppText weight="bold" size="sm">
                  {`${run.direction} · ${run.scope}`}
                </AppText>
                <AppText size="xs" color={COLORS.textMuted} style={styles.meta}>
                  {[relativeTime(run.started_at), run.note].filter(Boolean).join(' · ')}
                </AppText>
              </View>
              <Badge tone={run.reachable ? (run.fail_count ? 'pending' : 'success') : 'danger'}>
                {run.reachable ? `${run.ok_count}/${run.ok_count + run.fail_count}` : 'no answer'}
              </Badge>
            </View>
          ))}
        </Card>

        <ActionButton
          tone="neutral"
          label={pull.busy ? 'Pulling…' : 'Pull masters from Tally'}
          onPress={askPull}
          disabled={pull.busy || !cfg.enabled}
        />
      </AsyncBoundary>
    </Screen>
  );
}

function Count({ label, value, tone }) {
  return (
    <View style={styles.count}>
      <AppText weight="bold" size="lg" color={tone || COLORS.text}>{value ?? 0}</AppText>
      <AppText size="xs" color={COLORS.textMuted}>{label}</AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  counts: { flexDirection: 'row', justifyContent: 'space-around' },
  count: { alignItems: 'center', gap: 2 },
  note: { marginTop: 12, textAlign: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 14, gap: 10 },
  ruled: { borderTopWidth: 1, borderTopColor: COLORS.borderLight },
  body: { flex: 1 },
  meta: { marginTop: 3 },
});
