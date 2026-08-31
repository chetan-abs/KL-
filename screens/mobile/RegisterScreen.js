import React from 'react';
import { View, TouchableOpacity, RefreshControl, StyleSheet } from 'react-native';

import { COLORS } from '../../constants/colors';
import { Payments } from '../../services/endpoints';
import { useApi, useAction } from '../../hooks/useApi';
import { rupees } from '../../utils/format';
import { isSearchActive, normalizeSearch } from '../../utils/search';
import { promptText, showAlert } from '../../services/confirm';
import AppText from '../../components/AppText';
import Screen from '../../components/mobile/Screen';
import ScreenHeader from '../../components/mobile/ScreenHeader';
import Card from '../../components/mobile/Card';
import Field from '../../components/mobile/Field';
import Avatar from '../../components/mobile/Avatar';
import Badge from '../../components/mobile/Badge';
import AsyncBoundary from '../../components/mobile/AsyncBoundary';

/**
 * The party register — who owes what, and for how long.
 *
 * Ageing is the sort key, not the name: this list is opened to answer "who is
 * overdue", and a party at 62 days must not sit three screens below one at 8.
 * The badge reddens past 45 days, which is where the approval queue starts
 * flagging new orders against the balance.
 *
 * The figures here are real now — `closing_balance` is a cache of issued
 * invoices minus receipts minus issued credit notes, recomputed by the server
 * whenever one of those moves. Tapping a party with a balance records a receipt
 * against it, which is the fastest path from "they paid me" to the ledger
 * agreeing.
 *
 * Search runs through `utils/search.js` so the noise set (spaces, dots, dashes)
 * is stripped consistently with every other list in the app.
 */
const OVERDUE_DAYS = 45;

export default function RegisterScreen({ role, nav }) {
  const { data, loading, error, refreshing, reload, refresh } = useApi(
    () => Payments.outstanding(),
    []
  );
  const [query, setQuery] = React.useState('');

  const collect = useAction(
    ({ id, amount }) => Payments.record({ customer_id: id, amount, mode: 'cash' }),
    {
      onDone: (result) => {
        showAlert('Receipt recorded', `${result.receipt_no} — balance now ${rupees(result.closing_balance)}.`);
        reload();
      },
      onFail: (message) => showAlert('Could not record', message),
    }
  );

  const parties = React.useMemo(() => {
    const rows = data?.parties || [];
    if (!isSearchActive(query)) return rows;
    const needle = normalizeSearch(query);
    return rows.filter((p) =>
      normalizeSearch(`${p.name} ${p.area || ''} ${p.type || ''}`).includes(needle)
    );
  }, [data, query]);

  const total = (data?.parties || []).reduce((sum, p) => sum + Number(p.outstanding || 0), 0);

  function collectFrom(party) {
    if (Number(party.outstanding) <= 0) return;
    promptText({
      title: `Receipt from ${party.name}`,
      message: `They owe ${rupees(party.outstanding)}. How much came in?`,
      placeholder: 'Amount in rupees',
      confirmLabel: 'Record',
      onSubmit: (value) => {
        const amount = Number(String(value).replace(/[^0-9.]/g, ''));
        if (!Number.isFinite(amount) || amount <= 0) {
          return showAlert('Not recorded', 'Enter an amount greater than zero.');
        }
        collect.run({ id: party.masterid, amount });
      },
    });
  }

  return (
    <Screen
      header={
        <ScreenHeader
          clock=""
          role={role.name}
          title="Register"
          subtitle={
            loading ? 'Loading…' : `${(data?.parties || []).length} parties · ${rupees(total)} out`
          }
          badge="Ledger"
          badgeTone="onBrand"
        />
      }
      nav={nav}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={COLORS.brand} />
      }
    >
      <Field
        value={query}
        onChangeText={setQuery}
        placeholder="Search party, area or type"
        autoCapitalize="none"
      />

      <AsyncBoundary
        loading={loading}
        error={error}
        onRetry={reload}
        empty={!parties.length}
        emptyText={
          isSearchActive(query) ? `Nothing matches “${query.trim()}”.` : 'No parties on the register yet.'
        }
      >
        <Card title={isSearchActive(query) ? `${parties.length} matching` : 'By ageing'} flush>
          {parties.map((party, index) => {
            const outstanding = Number(party.outstanding || 0);
            const days = Number(party.days || 0);
            const overdue = outstanding > 0 && days >= OVERDUE_DAYS;
            const clear = outstanding <= 0;

            return (
              <TouchableOpacity
                key={party.masterid}
                style={[styles.row, index ? styles.ruled : null, overdue ? styles.overdue : null]}
                onPress={() => collectFrom(party)}
                disabled={clear || collect.busy}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={
                  clear
                    ? `${party.name}, clear`
                    : `${party.name}, ${rupees(outstanding)} outstanding — record a receipt`
                }
              >
                <Avatar name={party.name} size={38} />

                <View style={styles.body}>
                  <AppText weight="bold" size="sm" numberOfLines={1}>{party.name}</AppText>
                  <AppText size="xs" color={COLORS.textSecondary} style={styles.meta}>
                    {[party.area, party.type].filter(Boolean).join(' · ') || 'No area set'}
                  </AppText>
                </View>

                <View style={styles.right}>
                  <AppText
                    weight="bold"
                    size="sm"
                    color={clear ? COLORS.success : overdue ? COLORS.error : COLORS.text}
                  >
                    {clear ? 'Clear' : rupees(outstanding)}
                  </AppText>
                  {clear ? null : (
                    <Badge tone={overdue ? 'danger' : 'neutral'} style={styles.badge}>
                      {days ? `${days}d` : 'current'}
                    </Badge>
                  )}
                </View>
              </TouchableOpacity>
            );
          })}
        </Card>
      </AsyncBoundary>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 14 },
  ruled: { borderTopWidth: 1, borderTopColor: COLORS.borderLight },
  overdue: { backgroundColor: COLORS.errorRow },
  body: { flex: 1, paddingHorizontal: 11 },
  meta: { marginTop: 3 },
  right: { alignItems: 'flex-end' },
  badge: { marginTop: 5 },
});
