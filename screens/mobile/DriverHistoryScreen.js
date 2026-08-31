import React from 'react';
import { View, RefreshControl, StyleSheet } from 'react-native';

import { COLORS } from '../../constants/colors';
import { Dispatch } from '../../services/endpoints';
import { useApi } from '../../hooks/useApi';
import { formatTime } from '../../utils/datetime';
import AppText from '../../components/AppText';
import Screen from '../../components/mobile/Screen';
import ScreenHeader from '../../components/mobile/ScreenHeader';
import Card from '../../components/mobile/Card';
import StatRow from '../../components/mobile/StatRow';
import Avatar from '../../components/mobile/Avatar';
import Badge from '../../components/mobile/Badge';
import AsyncBoundary from '../../components/mobile/AsyncBoundary';

/**
 * What Kamal has already closed today.
 *
 * Separate from the route (11) so the live list only ever holds stops that still
 * need driving — a route that grows a tail of completed rows is one the driver
 * has to scroll past at every stop.
 *
 * A failed stop is listed beside the delivered ones rather than hidden. It is a
 * real outcome the day has to account for, and it is the one somebody has to
 * re-schedule.
 */
export default function DriverHistoryScreen({ role, nav }) {
  const { data, loading, error, refreshing, reload, refresh } = useApi(() => Dispatch.myRoute(), []);

  const stops = data?.stops || [];
  const done = stops.filter((s) => s.state === 'done');
  const failed = stops.filter((s) => s.state === 'failed');
  const remaining = stops.length - done.length - failed.length;
  const closed = [...done, ...failed];

  return (
    <Screen
      header={
        <ScreenHeader
          clock=""
          role={role.name}
          title="Completed"
          subtitle={loading ? 'Loading…' : "Today's deliveries"}
          badge={`${done.length} done`}
          badgeTone="success"
        />
      }
      nav={nav}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={COLORS.brand} />
      }
    >
      <AsyncBoundary loading={loading} error={error} onRetry={reload}>
        <StatRow
          stats={[
            { label: 'Delivered', value: done.length, tone: 'success' },
            { label: 'Remaining', value: Math.max(0, remaining), tone: 'info' },
            { label: 'Failed', value: failed.length, tone: 'danger' },
          ]}
        />

        <Card title="Closed today" flush>
          {closed.length ? (
            closed.map((stop, index) => {
              const ok = stop.state === 'done';
              return (
                <View key={stop.id} style={[styles.row, index ? styles.ruled : null]}>
                  <Avatar
                    label={ok ? '✓' : '✗'}
                    color={ok ? COLORS.actionApprove : COLORS.actionReject}
                    size={38}
                  />
                  <View style={styles.body}>
                    <AppText weight="bold" size="sm" numberOfLines={1}>{stop.party}</AppText>
                    <AppText size="xs" color={COLORS.textSecondary} style={styles.meta}>
                      {[
                        `#${stop.order_id}`,
                        stop.delivered_at ? formatTime(stop.delivered_at) : null,
                        stop.received_by ? `to ${stop.received_by}` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </AppText>
                  </View>
                  <Badge tone={ok ? 'success' : 'danger'}>{ok ? 'Photo ✓' : 'Failed'}</Badge>
                </View>
              );
            })
          ) : (
            <View style={styles.empty}>
              <AppText size="sm" color={COLORS.textMuted}>Nothing closed yet today.</AppText>
            </View>
          )}
        </Card>
      </AsyncBoundary>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 13, paddingHorizontal: 14 },
  ruled: { borderTopWidth: 1, borderTopColor: COLORS.borderLight },
  body: { flex: 1, paddingHorizontal: 11 },
  meta: { marginTop: 3 },
  empty: { padding: 22, alignItems: 'center' },
});
