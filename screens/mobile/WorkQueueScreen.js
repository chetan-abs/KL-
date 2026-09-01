import React from 'react';
import { View, TouchableOpacity, RefreshControl, StyleSheet } from 'react-native';

import { useThemeColors } from '../../context/ThemeContext';
import { Picking, Verification, Billing } from '../../services/endpoints';
import { useApi } from '../../hooks/useApi';
import { rupees } from '../../utils/format';
import { businessDate } from '../../utils/datetime';
import AppText from '../../components/AppText';
import Screen from '../../components/mobile/Screen';
import ScreenHeader from '../../components/mobile/ScreenHeader';
import Card from '../../components/mobile/Card';
import Avatar from '../../components/mobile/Avatar';
import Badge from '../../components/mobile/Badge';
import ProgressBar from '../../components/mobile/ProgressBar';
import AsyncBoundary from '../../components/mobile/AsyncBoundary';

/**
 * The list that precedes 07, 08 and 09 — what is waiting for this role.
 *
 * One screen for three roles because the shape is identical: a stack of orders,
 * each with a party, a size and a state, opening onto that role's working sheet.
 * Three near-copies would have drifted the moment one of them grew a column.
 *
 * Each variant brings its own state map rather than sharing a union of
 * everyone's — a picker never sees "invoiced" and should not have a branch that
 * could show it.
 */
function makeVARIANTS(COLORS) {
  return {
  pick: {
    title: 'To Pick',
    empty: 'Nothing waiting in the godown.',
    fetch: () => Picking.queue(),
    rows: (data) =>
      (data?.picks || []).map((row) => ({
        id: row.order_id,
        order_id: row.order_id,
        party: row.party,
        meta: `#${row.order_id} · ${row.line_count} lines`,
        done: Number(row.done),
        total: Number(row.line_count),
        state: row.status === 'picking' ? 'progress' : 'waiting',
      })),
    states: {
      progress: { badge: 'pending', label: 'In progress', row: COLORS.warningRow, open: true },
      waiting: { badge: 'neutral', label: 'Waiting', row: COLORS.surface, open: true },
    },
  },

  verify: {
    title: 'To Verify',
    empty: 'Nothing waiting for a count.',
    fetch: () => Verification.queue(),
    rows: (data) =>
      (data?.verifications || []).map((row) => ({
        id: row.order_id,
        order_id: row.order_id,
        party: row.party,
        meta: `#${row.order_id} · ${row.line_count} lines`,
        state: row.status === 'picked' ? 'ready' : 'verified',
      })),
    states: {
      ready: { badge: 'pending', label: 'Ready', row: COLORS.warningRow, open: true },
      verified: { badge: 'success', label: 'Verified', row: COLORS.surface, open: false },
    },
  },

  invoice: {
    title: 'To Bill',
    empty: 'Nothing waiting to be billed.',
    fetch: () => Billing.queue(),
    rows: (data) => [
      ...(data?.awaiting || []).map((row) => ({
        id: `o${row.order_id}`,
        order_id: row.order_id,
        party: row.party,
        meta: `#${row.order_id} · ${rupees(row.total_amount)}`,
        state: 'ready',
      })),
      ...(data?.invoices || []).map((row) => ({
        id: `i${row.id}`,
        order_id: row.order_id,
        party: row.party_name,
        meta: `${row.invoice_no} · ${rupees(row.grand_total, { decimals: 'auto' })}`,
        state: 'invoiced',
      })),
    ],
    states: {
      ready: { badge: 'pending', label: 'Ready to bill', row: COLORS.warningRow, open: true },
      invoiced: { badge: 'success', label: 'Invoiced', row: COLORS.surface, open: false },
    },
  },
};
}

export default function WorkQueueScreen({ role, variant, nav, onOpen }) {
  const COLORS = useThemeColors();
  const VARIANTS = React.useMemo(() => makeVARIANTS(COLORS), [COLORS]);
  const styles = React.useMemo(() => StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 13, paddingHorizontal: 14 },
  ruled: { borderTopWidth: 1, borderTopColor: COLORS.borderLight },
  body: { flex: 1, paddingHorizontal: 11 },
  meta: { marginTop: 3 },
  bar: { marginTop: 7 },
}), [COLORS]);
  const config = VARIANTS[variant];
  const { data, loading, error, refreshing, reload, refresh } = useApi(config.fetch, [variant]);

  const rows = config.rows(data);
  const open = rows.filter((r) => config.states[r.state]?.open).length;

  return (
    <Screen
      header={
        <ScreenHeader
          clock={businessDate()}
          role={role.name}
          title={config.title}
          subtitle={loading ? 'Loading…' : `${rows.length} order${rows.length === 1 ? '' : 's'}`}
          badge={open ? `${open} open` : 'Clear'}
          badgeTone={open ? 'pending' : 'success'}
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
        empty={!rows.length}
        emptyGlyph="✓"
        emptyText={config.empty}
      >
        <Card title="Orders" flush>
          {rows.map((row, index) => {
            const look = config.states[row.state] || {
              badge: 'neutral',
              label: row.state,
              row: COLORS.surface,
              open: false,
            };

            return (
              <TouchableOpacity
                key={row.id}
                style={[styles.row, { backgroundColor: look.row }, index ? styles.ruled : null]}
                onPress={() => (look.open ? onOpen?.(row) : null)}
                disabled={!look.open}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={`${row.party}, ${look.label}`}
              >
                <Avatar name={row.party} size={38} />

                <View style={styles.body}>
                  <AppText weight="bold" size="sm" numberOfLines={1}>
                    {row.party}
                  </AppText>
                  <AppText size="xs" color={COLORS.textSecondary} style={styles.meta}>
                    {row.meta}
                  </AppText>
                  {row.done > 0 && row.done < row.total ? (
                    <ProgressBar value={row.done} total={row.total} style={styles.bar} />
                  ) : null}
                </View>

                <Badge tone={look.badge}>{look.label}</Badge>
              </TouchableOpacity>
            );
          })}
        </Card>
      </AsyncBoundary>
    </Screen>
  );
}

