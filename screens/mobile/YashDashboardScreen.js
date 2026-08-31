import React from 'react';
import { View, TouchableOpacity, RefreshControl, StyleSheet } from 'react-native';

import { COLORS } from '../../constants/colors';
import { Orders, Picking, Verification, Billing, Payments, Alerts } from '../../services/endpoints';
import { useApi } from '../../hooks/useApi';
import { rupeesShort } from '../../utils/format';
import { businessDate } from '../../utils/datetime';
import AppText from '../../components/AppText';
import Screen from '../../components/mobile/Screen';
import ScreenHeader from '../../components/mobile/ScreenHeader';
import Card from '../../components/mobile/Card';
import StatRow from '../../components/mobile/StatRow';
import Badge from '../../components/mobile/Badge';
import ProgressBar from '../../components/mobile/ProgressBar';
import NoticeBar from '../../components/mobile/NoticeBar';
import AsyncBoundary from '../../components/mobile/AsyncBoundary';

/**
 * 24 — Yash's business view.
 *
 * The pipeline is the point of the screen: one count per stage, so the question
 * "where is everything stuck today" is answered without opening anything. Three
 * waiting on verification is a picker problem; fourteen waiting on approval is
 * Yash's own.
 *
 * Alerts sit above the pipeline rather than below it because they are the things
 * that need a person today, and this is the screen the owner opens first.
 *
 * Assembled from the same endpoints the working screens use rather than a
 * bespoke reporting route — one less query to keep in step with the pipeline,
 * and every figure here is one somebody else is already acting on.
 */
const PIPELINE_TONE = {
  pending: COLORS.warning,
  info: COLORS.primary,
  warning: COLORS.accent,
  violet: COLORS.secondary,
  success: COLORS.success,
};

export default function YashDashboardScreen({
  role, nav, onOpenOrders, onOpenReports, onOpenRateChanges, onOpenTally, onOpenAttendanceRegister,
}) {
  const pending = useApi(() => Orders.list({ status: 'pending' }), []);
  const confirmed = useApi(() => Orders.list({ status: 'confirmed' }), []);
  const picks = useApi(() => Picking.queue(), []);
  const verifies = useApi(() => Verification.queue(), []);
  const billing = useApi(() => Billing.queue(), []);
  const outstanding = useApi(() => Payments.outstanding(), []);
  const alerts = useApi(() => Alerts.list({ unread: 1, limit: 5 }), []);

  const feeds = [pending, confirmed, picks, verifies, billing, outstanding, alerts];
  const loading = feeds.some((f) => f.loading);
  const error = feeds.find((f) => f.error)?.error;
  const reload = () => feeds.forEach((f) => f.reload());
  const refresh = () => feeds.forEach((f) => f.refresh());

  const awaitingApproval =
    (pending.data?.orders?.length || 0) + (confirmed.data?.orders?.length || 0);
  const picking = picks.data?.picks?.length || 0;
  const awaitingVerify = (verifies.data?.verifications || []).filter((v) => v.status === 'picked').length;
  const toInvoice = billing.data?.awaiting?.length || 0;
  const invoices = billing.data?.invoices || [];

  const parties = outstanding.data?.parties || [];
  const totalOut = parties.reduce((sum, p) => sum + Number(p.outstanding || 0), 0);
  const billedTotal = invoices.reduce((sum, i) => sum + Number(i.grand_total || 0), 0);

  const pipeline = [
    { stage: 'Awaiting approval', count: awaitingApproval, tone: 'pending' },
    { stage: 'Picking', count: picking, tone: 'info' },
    { stage: 'Awaiting verify', count: awaitingVerify, tone: 'warning' },
    { stage: 'To invoice', count: toInvoice, tone: 'violet' },
  ];
  const busiest = Math.max(1, ...pipeline.map((s) => s.count));

  const topParties = parties
    .filter((p) => Number(p.outstanding) > 0)
    .slice(0, 5);
  const topValue = Math.max(1, ...topParties.map((p) => Number(p.outstanding)));

  const unread = alerts.data?.notifications || [];

  return (
    <Screen
      header={
        <ScreenHeader
          clock={businessDate()}
          role={role.name}
          title="Business"
          subtitle={loading ? 'Loading…' : 'Today'}
          badge="Owner"
          badgeTone="onBrand"
        />
      }
      nav={nav}
      refreshControl={
        <RefreshControl
          refreshing={feeds.some((f) => f.refreshing)}
          onRefresh={refresh}
          tintColor={COLORS.brand}
        />
      }
    >
      <AsyncBoundary loading={loading} error={error} onRetry={reload}>
        <StatRow
          stats={[
            { label: 'Billed', value: rupeesShort(billedTotal), tone: 'success' },
            { label: 'Invoices', value: invoices.length, tone: 'info' },
            { label: 'Outstanding', value: rupeesShort(totalOut), tone: 'danger' },
          ]}
        />

        {unread.length ? (
          <Card title={`Needs attention (${unread.length})`} flush>
            <View style={styles.alerts}>
              {unread.map((alert) => (
                <NoticeBar key={alert.id} tone={alert.tone}>
                  {alert.body || alert.title}
                </NoticeBar>
              ))}
            </View>
          </Card>
        ) : null}

        <TouchableOpacity onPress={onOpenOrders} activeOpacity={0.85} accessibilityRole="button">
          <Card title="Pipeline today" flush>
            {pipeline.map((stage, index) => (
              <View key={stage.stage} style={[styles.stage, index ? styles.ruled : null]}>
                <View style={styles.stageHead}>
                  <AppText size="sm" style={styles.flex}>{stage.stage}</AppText>
                  <Badge tone={stage.count ? stage.tone : 'neutral'}>{String(stage.count)}</Badge>
                </View>
                <ProgressBar
                  value={stage.count}
                  total={busiest}
                  tone={PIPELINE_TONE[stage.tone] || COLORS.brand}
                  style={styles.stageBar}
                />
              </View>
            ))}
          </Card>
        </TouchableOpacity>

        <Card title="Most owed" flush>
          {topParties.length ? (
            topParties.map((party, index) => (
              <View key={party.masterid} style={[styles.stage, index ? styles.ruled : null]}>
                <View style={styles.stageHead}>
                  <AppText weight="bold" size="sm" style={styles.flex} numberOfLines={1}>
                    {party.name}
                  </AppText>
                  <AppText
                    weight="bold"
                    size="sm"
                    color={Number(party.days) >= 45 ? COLORS.error : COLORS.brand}
                  >
                    {rupeesShort(party.outstanding)}
                  </AppText>
                </View>
                <ProgressBar value={Number(party.outstanding)} total={topValue} style={styles.stageBar} />
              </View>
            ))
          ) : (
            <View style={styles.empty}>
              <AppText size="sm" color={COLORS.textMuted}>Nothing outstanding.</AppText>
            </View>
          )}
        </Card>

        {/* The owner's three: what the business did, what it is waiting on him
            to decide, and whether the books are actually reaching Tally. */}
        <Card title="Owner" flush>
          {onOpenReports ? (
            <LinkRow
              title="Reports"
              subtitle="All twelve, with CSV and PDF"
              onPress={onOpenReports}
            />
          ) : null}
          {onOpenRateChanges ? (
            <LinkRow
              title="Rate changes"
              subtitle="Proposals waiting on you — R-11"
              onPress={onOpenRateChanges}
            />
          ) : null}
          {onOpenTally ? (
            <LinkRow
              title="Tally sync"
              subtitle="The outbox, and whether it is reaching Tally at all"
              onPress={onOpenTally}
            />
          ) : null}
          {onOpenAttendanceRegister ? (
            <LinkRow
              title="Attendance"
              subtitle="Who's in, who's late, who's absent — today"
              onPress={onOpenAttendanceRegister}
              last
            />
          ) : null}
        </Card>
      </AsyncBoundary>
    </Screen>
  );
}

/** A tappable row inside a flush Card. */
function LinkRow({ title, subtitle, onPress, last = false }) {
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.75} accessibilityRole="button">
      <View style={[styles.linkRow, last ? null : styles.ruledBottom]}>
        <View style={styles.flex}>
          <AppText weight="bold" size="sm">{title}</AppText>
          <AppText size="xs" color={COLORS.textSecondary} style={styles.linkMeta}>{subtitle}</AppText>
        </View>
        <AppText size="md" color={COLORS.primary}>→</AppText>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 13,
    paddingHorizontal: 14,
  },
  ruledBottom: { borderBottomWidth: 1, borderBottomColor: COLORS.borderLight },
  linkMeta: { marginTop: 3 },
  alerts: { padding: 12, gap: 9 },
  stage: { paddingVertical: 12, paddingHorizontal: 14 },
  ruled: { borderTopWidth: 1, borderTopColor: COLORS.borderLight },
  stageHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  stageBar: { marginTop: 8 },
  empty: { padding: 20, alignItems: 'center' },
});
