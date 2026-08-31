import React from 'react';
import { View, RefreshControl, StyleSheet } from 'react-native';

import { COLORS } from '../../constants/colors';
import { Purchases } from '../../services/endpoints';
import { useApi } from '../../hooks/useApi';
import { rupees } from '../../utils/format';
import { formatDate } from '../../utils/datetime';
import AppText from '../../components/AppText';
import Screen from '../../components/mobile/Screen';
import ScreenHeader from '../../components/mobile/ScreenHeader';
import Card from '../../components/mobile/Card';
import Badge from '../../components/mobile/Badge';
import NoticeBar from '../../components/mobile/NoticeBar';
import AsyncBoundary from '../../components/mobile/AsyncBoundary';

/**
 * 14 — Purchase rate movements.
 *
 * A rise is red and a fall is green from the *buyer's* point of view, which is
 * the opposite of a stock ticker and the right way round here: paying more is
 * the bad outcome. The old rate is struck through rather than dropped, because
 * the size of the move matters more than the new number on its own.
 *
 * Read from the `last_rate` stored on the purchase line, so an alert survives
 * the item master's cost being updated afterwards.
 */
export default function RateAlertScreen({ role, nav }) {
  const { data, loading, error, refreshing, reload, refresh } = useApi(
    () => Purchases.rateAlerts(),
    []
  );

  const alerts = data?.alerts || [];
  const rises = alerts.filter((a) => a.direction === 'up');
  const worst = rises.slice().sort((a, b) => Math.abs(b.change_percent) - Math.abs(a.change_percent))[0];

  return (
    <Screen
      header={
        <ScreenHeader
          clock=""
          role={role.name}
          title="Rate Alerts"
          subtitle={loading ? 'Loading…' : `${alerts.length} moved since last purchase`}
          badge={rises.length ? `${rises.length} up` : 'Steady'}
          badgeTone={rises.length ? 'pending' : 'success'}
        />
      }
      nav={nav}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={COLORS.brand} />
      }
    >
      <AsyncBoundary
        loading={loading}
        error={error}
        onRetry={reload}
        empty={!alerts.length}
        emptyGlyph="↔"
        emptyText="No supplier has moved their rate since the last purchase."
      >
        {worst ? (
          <NoticeBar tone="warning">
            {`${worst.item_name} up ${Math.abs(worst.change_percent)}% to ${rupees(worst.new_rate)}. Review the selling rate before the next sale.`}
          </NoticeBar>
        ) : null}

        <Card title="Movements" flush>
          {alerts.map((alert, index) => {
            const up = alert.direction === 'up';
            return (
              <View key={`${alert.item_id}-${index}`} style={[styles.row, index ? styles.ruled : null]}>
                <View style={styles.body}>
                  <AppText weight="bold" size="sm">{alert.item_name}</AppText>
                  <AppText size="xs" color={COLORS.textMuted} style={styles.meta}>
                    {[alert.supplier_name, formatDate(alert.purchase_date)].filter(Boolean).join(' · ')}
                  </AppText>
                  <View style={styles.rates}>
                    <AppText size="xs" color={COLORS.textMuted} style={styles.struck}>
                      {rupees(alert.old_rate)}
                    </AppText>
                    <AppText size="xs" color={COLORS.textSecondary}>→</AppText>
                    <AppText weight="bold" size="sm" color={up ? COLORS.error : COLORS.success}>
                      {rupees(alert.new_rate)}
                    </AppText>
                  </View>
                </View>

                <Badge tone={up ? 'danger' : 'success'}>
                  {`${up ? '▲' : '▼'} ${Math.abs(alert.change_percent)}%`}
                </Badge>
              </View>
            );
          })}
        </Card>
      </AsyncBoundary>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 13, paddingHorizontal: 14, gap: 10 },
  ruled: { borderTopWidth: 1, borderTopColor: COLORS.borderLight },
  body: { flex: 1 },
  meta: { marginTop: 3 },
  rates: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 6 },
  struck: { textDecorationLine: 'line-through' },
});
