import React from 'react';
import { View, TouchableOpacity, Linking, RefreshControl, StyleSheet } from 'react-native';

import { useThemeColors } from '../../context/ThemeContext';
import { Reports } from '../../services/endpoints';
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
 * 8, "Salesman view" — "His parties only, oldest first. One tap to call and
 * one tap to remind. Shows which parties are near the 60-day block."
 *
 * Reads the same bill-wise ledger the owner's Reports screen does
 * (GET /reportsuite/outstanding-bills), scoped to this salesman's own
 * parties by `salesman_id` — the server enforces that scope itself, this is
 * not a client-side filter of a wider list.
 *
 * "One tap to remind" opens WhatsApp with the same figures a manual
 * reminder would carry (invoice, date, days, amount) rather than sending
 * anything itself — the app has no WhatsApp account of its own, the same
 * reason the estimate share screen works this way.
 */
export default function CollectionsScreen({ role, user, nav }) {
  const COLORS = useThemeColors();
  const styles = React.useMemo(() => StyleSheet.create({
    row: { paddingVertical: 12, paddingHorizontal: 14 },
    ruled: { borderTopWidth: 1, borderTopColor: COLORS.borderLight },
    head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    meta: { marginTop: 3 },
    actions: { flexDirection: 'row', gap: 14, marginTop: 8 },
    action: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  }), [COLORS]);

  const { data, loading, error, refreshing, reload, refresh } = useApi(
    () => Reports.outstandingBills({ salesman_id: user?.id }),
    [user?.id]
  );

  // Grouped by party, oldest-first within each, parties themselves ordered
  // by their own oldest bill — the sheet's "oldest first" is about the
  // party a salesman should call next, not the invoice sort inside a call.
  const byParty = React.useMemo(() => {
    const groups = new Map();
    for (const row of data?.rows || []) {
      if (!groups.has(row.customer_id)) {
        groups.set(row.customer_id, { party: row.party, invoices: [] });
      }
      groups.get(row.customer_id).invoices.push(row);
    }
    return [...groups.values()]
      .map((g) => ({ ...g, oldest: Math.max(...g.invoices.map((i) => Number(i.age_days))) }))
      .sort((a, b) => b.oldest - a.oldest);
  }, [data]);

  const near60 = byParty.filter((g) => g.oldest >= 46 && g.oldest < 60);

  function remind(group) {
    const lines = group.invoices
      .map((inv) => `${inv.invoice_no} — ${formatDate(inv.invoice_date)}, ${inv.age_days}d, ${rupees(inv.outstanding)}`)
      .join('\n');
    const message = `${group.party}, a reminder on your outstanding bill(s):\n${lines}`;
    Linking.openURL(`https://wa.me/?text=${encodeURIComponent(message)}`);
  }

  return (
    <Screen
      nav={nav}
      header={
        <ScreenHeader
          clock=""
          role={role.name}
          title="Collections"
          subtitle={loading ? 'Loading…' : `${byParty.length} part${byParty.length === 1 ? 'y' : 'ies'} owe you`}
          badge={near60.length ? `${near60.length} near 60d` : 'Clear'}
          badgeTone={near60.length ? 'danger' : 'success'}
        />
      }
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={COLORS.brand} />
      }
    >
      <AsyncBoundary
        loading={loading}
        error={error}
        onRetry={reload}
        empty={!byParty.length}
        emptyGlyph="₹"
        emptyText="Nothing outstanding against your parties."
      >
        {near60.length ? (
          <NoticeBar tone="danger">
            {`${near60.map((g) => g.party).join(', ')} — within 60 days of the credit block (R-17). Collect before then.`}
          </NoticeBar>
        ) : null}

        <Card title="Oldest first" flush>
          {byParty.map((group, index) => {
            const total = group.invoices.reduce((sum, i) => sum + Number(i.outstanding), 0);
            const phone = group.invoices[0]?.phone;
            return (
              <View key={group.party + index} style={[styles.row, index ? styles.ruled : null]}>
                <View style={styles.head}>
                  <AppText weight="bold" size="sm" numberOfLines={1}>{group.party}</AppText>
                  <Badge tone={group.oldest >= 60 ? 'danger' : group.oldest >= 46 ? 'pending' : 'neutral'}>
                    {`${group.oldest}d`}
                  </Badge>
                </View>
                <AppText size="xs" color={COLORS.textSecondary} style={styles.meta}>
                  {`${group.invoices.length} bill(s) · ${rupees(total)} outstanding`}
                </AppText>

                <View style={styles.actions}>
                  {phone ? (
                    <TouchableOpacity
                      style={styles.action}
                      onPress={() => Linking.openURL(`tel:${phone}`)}
                      accessibilityRole="button"
                      accessibilityLabel={`Call ${group.party}`}
                    >
                      <AppText weight="bold" size="xs" color={COLORS.primary}>📞 Call</AppText>
                    </TouchableOpacity>
                  ) : null}
                  <TouchableOpacity
                    style={styles.action}
                    onPress={() => remind(group)}
                    accessibilityRole="button"
                    accessibilityLabel={`Remind ${group.party}`}
                  >
                    <AppText weight="bold" size="xs" color={COLORS.primary}>💬 Remind</AppText>
                  </TouchableOpacity>
                </View>
              </View>
            );
          })}
        </Card>
      </AsyncBoundary>
    </Screen>
  );
}
