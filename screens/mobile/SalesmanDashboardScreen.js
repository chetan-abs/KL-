import React from 'react';
import { View, TouchableOpacity, RefreshControl, StyleSheet } from 'react-native';

import { useThemeColors } from '../../context/ThemeContext';
import { Field as FieldApi } from '../../services/endpoints';
import { useApi } from '../../hooks/useApi';
import { rupees, rupeesShort } from '../../utils/format';
import { businessDate, formatTime } from '../../utils/datetime';
import AppText from '../../components/AppText';
import Screen from '../../components/mobile/Screen';
import ScreenHeader from '../../components/mobile/ScreenHeader';
import Card from '../../components/mobile/Card';
import StatRow from '../../components/mobile/StatRow';
import Badge from '../../components/mobile/Badge';
import ActionButton from '../../components/mobile/ActionButton';
import AsyncBoundary from '../../components/mobile/AsyncBoundary';

/**
 * 18 — Monu's day.
 *
 * A no-order visit is listed beside the orders rather than filtered out, and
 * carries the reason given in the field. It is a visit that happened and it is
 * what the beat is measured on — hiding it would make a day of nine calls and
 * two orders look like a day of two calls.
 *
 * This is `is_no_order` on the order row, not a cancelled order: reusing
 * "cancelled" for it made a genuine cancellation indistinguishable from an
 * unproductive visit, so every cancellation was reported as one and dropped out
 * of sales.
 *
 * Scoped to the caller by the server — `/field/day` reads req.user.id and takes
 * no grant, which is how a salesman sees their own book without being able to
 * read the branch's.
 */
export default function SalesmanDashboardScreen({
  role, nav, onNewOrder, onNewDealer, onOpenScheme, onOpenHandover, onOpenCollections,
}) {
  const COLORS = useThemeColors();
  const styles = React.useMemo(() => StyleSheet.create({
  flex: { flex: 1 },
  pair: { flexDirection: 'row', gap: 10 },
  half: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 14, gap: 10 },
  ruled: { borderTopWidth: 1, borderTopColor: COLORS.borderLight },
  body: { flex: 1 },
  meta: { marginTop: 3 },
  empty: { padding: 20, alignItems: 'center' },
  link: { flexDirection: 'row', alignItems: 'center', gap: 10 },
}), [COLORS]);
  const { data, loading, error, refreshing, reload, refresh } = useApi(() => FieldApi.day(), []);

  const totals = data?.totals || {};
  const visits = data?.visits || [];

  return (
    <Screen
      header={
        <ScreenHeader
          clock={businessDate()}
          role={role.name}
          title={`Hello, ${role.name}`}
          subtitle={loading ? 'Loading…' : `${visits.length} visit${visits.length === 1 ? '' : 's'} today`}
          badge="On beat"
          badgeTone="success"
        />
      }
      nav={nav}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={COLORS.brand} />
      }
      footer={
        <View style={styles.pair}>
          <ActionButton label="+ New Dealer" tone="neutral" onPress={onNewDealer} style={styles.half} />
          <ActionButton label="Take Order  →" tone="brand" onPress={onNewOrder} style={styles.half} />
        </View>
      }
    >
      <AsyncBoundary loading={loading} error={error} onRetry={reload}>
        <StatRow
          stats={[
            { label: 'Orders', value: Number(totals.orders || 0), tone: 'info' },
            { label: 'Value', value: rupeesShort(totals.value || 0), tone: 'success' },
            { label: 'No-order', value: Number(totals.no_order || 0), tone: 'danger' },
          ]}
        />

        <Card title="Today's visits" flush>
          {visits.length ? (
            visits.map((visit, index) => {
              const noOrder = Boolean(visit.is_no_order);
              return (
                <View key={visit.order_id} style={[styles.row, index ? styles.ruled : null]}>
                  <View style={styles.body}>
                    <AppText weight="bold" size="sm" numberOfLines={1}>{visit.party}</AppText>
                    <AppText size="xs" color={COLORS.textSecondary} style={styles.meta}>
                      {[visit.area, formatTime(visit.created_at), noOrder ? visit.notes : null]
                        .filter(Boolean)
                        .join(' · ')}
                    </AppText>
                  </View>
                  {noOrder ? (
                    <Badge tone="danger">No order</Badge>
                  ) : (
                    <AppText weight="bold" size="sm" color={COLORS.success}>
                      {rupees(visit.total_amount)}
                    </AppText>
                  )}
                </View>
              );
            })
          ) : (
            <View style={styles.empty}>
              <AppText size="sm" color={COLORS.textMuted}>
                No calls recorded yet today.
              </AppText>
            </View>
          )}
        </Card>

        {/* The scheme belongs to the salesman's day but not to their tab bar —
            four tabs is the budget, and this is consulted at an electrician's
            counter rather than navigated to. */}
        <TouchableOpacity
          onPress={onOpenScheme}
          activeOpacity={0.75}
          accessibilityRole="button"
          accessibilityLabel="Open the electrician scheme"
        >
          <Card>
            <View style={styles.link}>
              <View style={styles.flex}>
                <AppText weight="bold" size="sm">Electrician Scheme</AppText>
                <AppText size="xs" color={COLORS.textSecondary} style={styles.meta}>
                  Slabs and running totals
                </AppText>
              </View>
              <AppText size="md" color={COLORS.primary}>→</AppText>
            </View>
          </Card>
        </TouchableOpacity>

        {/* Section 8 — what you collected today, declared before you hand it
            over. It sits at the end of the day's card for the same reason the
            close does on Sibu's screen: it is the last thing done. */}
        {onOpenHandover ? (
          <TouchableOpacity
            onPress={onOpenHandover}
            activeOpacity={0.75}
            accessibilityRole="button"
            accessibilityLabel="Declare today's collections"
          >
            <Card>
              <View style={styles.link}>
                <View style={styles.flex}>
                  <AppText weight="bold" size="sm">Hand in collections</AppText>
                  <AppText size="xs" color={COLORS.textSecondary} style={styles.meta}>
                    Declare the cash and cheques you are carrying
                  </AppText>
                </View>
                <AppText size="md" color={COLORS.primary}>→</AppText>
              </View>
            </Card>
          </TouchableOpacity>
        ) : null}

        {/* 8, "Salesman view" — his parties only, oldest first, one tap to
            call, one tap to remind. */}
        {onOpenCollections ? (
          <TouchableOpacity
            onPress={onOpenCollections}
            activeOpacity={0.75}
            accessibilityRole="button"
            accessibilityLabel="Open collections"
          >
            <Card>
              <View style={styles.link}>
                <View style={styles.flex}>
                  <AppText weight="bold" size="sm">Collections</AppText>
                  <AppText size="xs" color={COLORS.textSecondary} style={styles.meta}>
                    Who owes you, oldest first — call or remind in one tap
                  </AppText>
                </View>
                <AppText size="md" color={COLORS.primary}>→</AppText>
              </View>
            </Card>
          </TouchableOpacity>
        ) : null}
      </AsyncBoundary>
    </Screen>
  );
}


