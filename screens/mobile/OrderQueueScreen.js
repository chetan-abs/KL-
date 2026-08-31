import React from 'react';
import { View, TouchableOpacity, RefreshControl, StyleSheet } from 'react-native';

import { COLORS } from '../../constants/colors';
import { Orders } from '../../services/endpoints';
import { useApi } from '../../hooks/useApi';
import { rupees } from '../../utils/format';
import { relativeTime, businessDate } from '../../utils/datetime';
import AppText from '../../components/AppText';
import Screen from '../../components/mobile/Screen';
import ScreenHeader from '../../components/mobile/ScreenHeader';
import Card from '../../components/mobile/Card';
import StatRow from '../../components/mobile/StatRow';
import Badge from '../../components/mobile/Badge';
import Avatar from '../../components/mobile/Avatar';
import NoticeBar from '../../components/mobile/NoticeBar';
import AsyncBoundary from '../../components/mobile/AsyncBoundary';

/**
 * 02 — Manas order queue. Every order routes through here; approval is
 * mandatory (R01).
 *
 * The meta line is one string — amount, party type, salesman, age — because on a
 * 360pt screen those four facts compete for the same row, and stacking them
 * turns a scannable list into a wall. The party name is the only thing set at
 * reading weight; everything else is support.
 *
 * An order against a long-overdue balance is flagged on the row *and* summarised
 * above the list. The flag is the fact; the summary is what stops it being
 * scrolled past.
 */
const OVERDUE_DAYS = 45;

export default function OrderQueueScreen({ role, nav, onOpenOrder }) {
  const pending = useApi(() => Orders.list({ status: 'pending' }), []);
  const confirmed = useApi(() => Orders.list({ status: 'confirmed' }), []);

  // Both spellings of "not yet approved" belong in one queue: POST /orders sets
  // `confirmed` for a salesman holding the confirm grant, and `pending` for one
  // who does not. Manas has to see both.
  const orders = React.useMemo(() => {
    const rows = [...(pending.data?.orders || []), ...(confirmed.data?.orders || [])];
    return rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }, [pending.data, confirmed.data]);

  const loading = pending.loading || confirmed.loading;
  const error = pending.error || confirmed.error;
  const reload = () => {
    pending.reload();
    confirmed.reload();
  };
  const refresh = () => {
    pending.refresh();
    confirmed.refresh();
  };

  const overdue = orders.filter((o) => Number(o.outstanding_days) >= OVERDUE_DAYS);

  return (
    <Screen
      header={
        <ScreenHeader
          clock={businessDate()}
          role={role.name}
          title="Order Queue"
          subtitle={loading ? 'Loading…' : `${orders.length} pending approval`}
          badge={orders.length ? `${orders.length} new` : 'Clear'}
          badgeTone={orders.length ? 'violet' : 'success'}
        />
      }
      nav={nav}
      refreshControl={
        <RefreshControl
          refreshing={pending.refreshing || confirmed.refreshing}
          onRefresh={refresh}
          tintColor={COLORS.brand}
        />
      }
    >
      <AsyncBoundary
        loading={loading}
        error={error}
        onRetry={reload}
        empty={!orders.length}
        emptyGlyph="✓"
        emptyText="Nothing waiting for approval."
      >
        <StatRow
          stats={[
            { label: 'Pending', value: orders.length, tone: 'pending' },
            { label: 'Overdue party', value: overdue.length, tone: overdue.length ? 'danger' : 'neutral' },
            {
              label: 'Value',
              value: rupees(orders.reduce((sum, o) => sum + Number(o.total_amount || 0), 0)),
              tone: 'success',
            },
          ]}
        />

        <Card title="Pending approval" flush style={styles.spaced}>
          {orders.map((order, index) => {
            const late = Number(order.outstanding_days) >= OVERDUE_DAYS;
            return (
              <TouchableOpacity
                key={order.order_id}
                style={[styles.row, index ? styles.ruled : null]}
                onPress={() => onOpenOrder(order)}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={`${order.customer_name}, ${rupees(order.total_amount)}`}
              >
                <Avatar name={order.customer_name} />

                <View style={styles.body}>
                  <AppText weight="bold" size="sm" numberOfLines={1}>
                    {order.customer_name}
                  </AppText>
                  <AppText size="xs" color={COLORS.textSecondary} style={styles.meta} numberOfLines={1}>
                    {[
                      rupees(order.total_amount),
                      order.customer_group,
                      order.salesman_name,
                      relativeTime(order.created_at),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </AppText>
                </View>

                <View style={styles.marks}>
                  <Badge tone="pending">New</Badge>
                  {late ? (
                    <Badge tone="danger" style={styles.flag}>
                      {`${order.outstanding_days}d due ⚠`}
                    </Badge>
                  ) : null}
                </View>
              </TouchableOpacity>
            );
          })}
        </Card>

        {overdue.length ? (
          <NoticeBar tone="warning" style={styles.spaced}>
            {`${overdue[0].customer_name} — ${overdue[0].outstanding_days} day outstanding. Review before approving.`}
          </NoticeBar>
        ) : null}
      </AsyncBoundary>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 13, paddingHorizontal: 14 },
  ruled: { borderTopWidth: 1, borderTopColor: COLORS.borderLight },
  // Flexed so a long trading name truncates instead of shoving the badges off
  // the card's right edge.
  body: { flex: 1, paddingHorizontal: 11 },
  meta: { marginTop: 3 },
  marks: { alignItems: 'flex-end', gap: 5 },
  flag: { marginTop: 1 },
  spaced: { marginTop: 12 },
});
