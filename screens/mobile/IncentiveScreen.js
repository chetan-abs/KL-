import React from 'react';
import { View, RefreshControl, StyleSheet } from 'react-native';

import { COLORS } from '../../constants/colors';
import { Incentives } from '../../services/endpoints';
import { useApi, useAction } from '../../hooks/useApi';
import { rupees, rupeesShort } from '../../utils/format';
import AppText from '../../components/AppText';
import Screen from '../../components/mobile/Screen';
import ScreenHeader from '../../components/mobile/ScreenHeader';
import Card from '../../components/mobile/Card';
import Badge from '../../components/mobile/Badge';
import NoticeBar from '../../components/mobile/NoticeBar';
import ProgressBar from '../../components/mobile/ProgressBar';
import ActionButton from '../../components/mobile/ActionButton';
import AsyncBoundary from '../../components/mobile/AsyncBoundary';

/**
 * Incentive progress — section 9.
 *
 * Twenty segments, and the one number that changes behaviour is the gap to the
 * next slab: a salesman at 88% of target is earning nothing and two percent of
 * target away from 80% of the base. So each row leads with the bar and the
 * percentage, and the payout follows.
 *
 * R-19 is given its own line rather than being netted into the achievement.
 * "Removed — unpaid 60d" is the sale that counted and was then taken back
 * because the party has not paid, and it is the thing a salesman most needs to
 * see: it is the difference between chasing a collection and chasing an order.
 */

/** The four rungs of section 9, for the legend. */
const SLAB_LEGEND = 'Below 90% pays nothing · 90–99% pays 80% · 100% pays the base · 101%+ pays 110% (the ceiling)';

const toneFor = (pct) => {
  if (pct >= 101) return 'success';
  if (pct >= 100) return 'success';
  if (pct >= 90) return 'pending';
  return 'neutral';
};

const thisMonth = () => new Date().toISOString().slice(0, 7);

export default function IncentiveScreen({ role, nav, onBack, params = {} }) {
  const employeeId = params.employeeId || role.key;
  const [period, setPeriod] = React.useState(params.period || thisMonth());

  const { data, loading, error, refreshing, reload, refresh } = useApi(
    () => Incentives.progress(employeeId, period),
    [employeeId, period]
  );

  const row = data?.period || {};
  const lines = data?.lines || [];
  const frozen = data?.frozen;
  const atRisk = data?.at_risk || [];

  const compute = useAction(() => Incentives.compute(employeeId, period), { onDone: reload });
  const approve = useAction(() => Incentives.approve(row.id), { onDone: reload });
  const pay = useAction(() => Incentives.pay(row.id), { onDone: reload });

  const shiftMonth = (by) => {
    const [y, m] = period.split('-').map(Number);
    setPeriod(new Date(Date.UTC(y, m - 1 + by, 1)).toISOString().slice(0, 7));
  };

  // Earning segments first — the ones paying nothing are the long tail and
  // burying the four that pay under sixteen that do not is the wrong way round.
  const ordered = [...lines].sort((a, b) => Number(b.payout) - Number(a.payout));
  const earning = ordered.filter((l) => Number(l.payout) > 0);

  return (
    <Screen
      header={
        <ScreenHeader
          clock=""
          role={role.name}
          title={employeeId === role.key ? 'My Incentive' : (data?.employee?.name || 'Incentive')}
          subtitle={`${period} · ${earning.length} of ${lines.length} segments earning`}
          badge={row.status ? row.status.toUpperCase() : 'DRAFT'}
          badgeTone={row.status === 'paid' || row.status === 'approved' ? 'success' : 'neutral'}
          onBack={params.from ? onBack : undefined}
          backLabel={params.backLabel || 'Back'}
        />
      }
      nav={nav}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={COLORS.brand} />
      }
      footer={
        role.approvesIncentives ? (
          <>
            {(!row.status || row.status === 'draft') ? (
              <ActionButton
                label={compute.busy ? 'Computing…' : 'Freeze this month'}
                onPress={compute.run}
                disabled={compute.busy}
              />
            ) : null}
            {row.status === 'draft' && row.id ? (
              <ActionButton
                label={approve.busy ? 'Approving…' : 'Approve the payout'}
                onPress={approve.run}
                disabled={approve.busy}
              />
            ) : null}
            {row.status === 'approved' ? (
              <ActionButton
                label={pay.busy ? 'Recording…' : 'Mark paid'}
                onPress={pay.run}
                disabled={pay.busy}
              />
            ) : null}
          </>
        ) : null
      }
    >
      <AsyncBoundary loading={loading} error={error} onRetry={reload}>
        <View style={styles.monthRow}>
          <ActionButton tone="neutral" size="sm" label="‹ Previous" onPress={() => shiftMonth(-1)} />
          <AppText weight="bold" size="sm">{period}</AppText>
          <ActionButton tone="neutral" size="sm" label="Next ›" onPress={() => shiftMonth(1)} />
        </View>

        <Card title="Estimated payout">
          <View style={styles.total}>
            <AppText weight="bold" size="xxl">{rupees(row.net_payout)}</AppText>
            {Number(row.share_pct) < 1 ? (
              <AppText size="xs" color={COLORS.textMuted} style={styles.meta}>
                {`${rupees(row.gross_payout)} shared between the showroom pair`}
              </AppText>
            ) : null}
            {!frozen ? (
              <AppText size="xs" color={COLORS.textMuted} style={styles.meta}>
                Live — recomputed every time this screen is opened.
              </AppText>
            ) : null}
          </View>
        </Card>

        {/* R-19, given its own place rather than netted away. */}
        {atRisk.length ? (
          <NoticeBar tone="warning">
            {`${atRisk.length} segment${atRisk.length > 1 ? 's have' : ' has'} sales removed `
              + 'because the invoice is unpaid beyond 60 days. Collecting brings them back.'}
          </NoticeBar>
        ) : null}

        <Card title={`Segments (${lines.length})`} flush>
          {ordered.map((line, index) => {
            const pct = Number(line.achieved_pct) || 0;
            return (
              <View key={line.segment_id} style={[styles.seg, index ? styles.ruled : null]}>
                <View style={styles.segHead}>
                  <AppText weight="bold" size="sm" style={styles.segName} numberOfLines={1}>
                    {line.segment_name}
                  </AppText>
                  <Badge tone={toneFor(pct)}>{`${pct.toFixed(0)}%`}</Badge>
                </View>

                <ProgressBar
                  value={Math.min(Number(line.achieved_net), Number(line.target))}
                  total={Number(line.target) || 1}
                  tone={pct >= 100 ? COLORS.success : pct >= 90 ? COLORS.warning : COLORS.border}
                />

                <View style={styles.segFoot}>
                  <AppText size="xs" color={COLORS.textMuted}>
                    {line.target_kind === 'qty'
                      ? `${Number(line.achieved_net)} of ${Number(line.target)} pieces`
                      : `${rupeesShort(line.achieved_net)} of ${rupeesShort(line.target)}`}
                  </AppText>
                  <AppText
                    weight="bold"
                    size="xs"
                    color={Number(line.payout) > 0 ? COLORS.success : COLORS.textMuted}
                  >
                    {Number(line.payout) > 0
                      ? `${rupees(line.payout)} (${line.slab_label || ''})`
                      : `base ${rupees(line.base_incentive)}`}
                  </AppText>
                </View>

                {Number(line.removed_unpaid) > 0 ? (
                  <AppText size="xs" color={COLORS.error} style={styles.meta}>
                    {`− ${rupeesShort(line.removed_unpaid)} removed, unpaid beyond 60 days`}
                  </AppText>
                ) : null}
              </View>
            );
          })}
        </Card>

        <NoticeBar tone="info">{SLAB_LEGEND}</NoticeBar>
      </AsyncBoundary>
    </Screen>
  );
}

const styles = StyleSheet.create({
  monthRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  total: { alignItems: 'center', paddingVertical: 6 },
  meta: { marginTop: 4, textAlign: 'center' },
  seg: { paddingVertical: 12, paddingHorizontal: 14, gap: 7 },
  ruled: { borderTopWidth: 1, borderTopColor: COLORS.borderLight },
  segHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  segName: { flex: 1 },
  segFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
});
