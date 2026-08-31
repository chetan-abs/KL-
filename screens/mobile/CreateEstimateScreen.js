import React from 'react';
import { View, TouchableOpacity, RefreshControl, StyleSheet } from 'react-native';

import { COLORS } from '../../constants/colors';
import { Field as FieldApi, Items, Customers } from '../../services/endpoints';
import { useApi, useAction } from '../../hooks/useApi';
import { rupees } from '../../utils/format';
import { formatDate } from '../../utils/datetime';
import { confirmAction, showAlert } from '../../services/confirm';
import AppText from '../../components/AppText';
import Screen from '../../components/mobile/Screen';
import ScreenHeader from '../../components/mobile/ScreenHeader';
import Card from '../../components/mobile/Card';
import DetailRow from '../../components/mobile/DetailRow';
import FormField from '../../components/mobile/Field';
import Select from '../../components/mobile/Select';
import Badge from '../../components/mobile/Badge';
import ActionButton from '../../components/mobile/ActionButton';
import NoticeBar from '../../components/mobile/NoticeBar';
import AsyncBoundary from '../../components/mobile/AsyncBoundary';

/**
 * 20 — Create estimate.
 *
 * An estimate books nothing: no stock is committed, no ledger row is written,
 * and it never reaches the approval queue. That is the whole reason it exists —
 * quoting a builder should not tie up goods someone else can sell today.
 *
 * Converting creates a real order at `pending`, and the rates are re-read from
 * the item master at that moment rather than carried across. The quote may be
 * weeks old, and the validity window exists precisely so last month's rates are
 * not honoured at this month's cost.
 */
export default function CreateEstimateScreen({ role, nav, onConverted }) {
  const list = useApi(() => FieldApi.estimates(), []);
  const parties = useApi(() => Customers.list({ limit: 200 }), []);
  const items = useApi(() => Items.list({ limit: 200 }), []);

  const [customerId, setCustomerId] = React.useState(null);
  const [validity, setValidity] = React.useState('7');
  const [lines, setLines] = React.useState([]);
  const [picking, setPicking] = React.useState(null);

  const catalogue = (items.data?.items || []).map((i) => ({
    value: i.masterid,
    label: `${i.name} · ${rupees(i.rate)}`,
  }));

  function addLine(itemId) {
    const master = (items.data?.items || []).find((i) => i.masterid === itemId);
    if (!master) return;
    setLines((prev) => [
      ...prev,
      { item_id: master.masterid, name: master.name, rate: Number(master.rate), qty: '1' },
    ]);
    setPicking(null);
  }

  const rows = lines.map((l) => ({ ...l, total: (Number(l.qty) || 0) * l.rate }));
  const total = rows.reduce((sum, r) => sum + r.total, 0);
  const ready = customerId && rows.length > 0;

  const create = useAction(
    () =>
      FieldApi.createEstimate({
        customer_id: customerId,
        valid_days: Number(validity) || 7,
        lines: rows.map((r) => ({ item_id: r.item_id, qty: Number(r.qty) })),
      }),
    {
      onDone: (result) => {
        showAlert('Estimate saved', `Quote for ${rupees(result.total_amount)} recorded. It books no stock.`);
        setLines([]);
        list.reload();
      },
      onFail: (message) => showAlert('Could not save', message),
    }
  );

  const convert = useAction((id) => FieldApi.convertEstimate(id), {
    onDone: (result) => {
      showAlert('Converted', `Order #${result.order_id} raised for ${rupees(result.total_amount)}. It needs approval.`);
      list.reload();
      onConverted?.();
    },
    onFail: (message) => showAlert('Could not convert', message),
  });

  return (
    <Screen
      header={
        <ScreenHeader
          clock=""
          role={role.name}
          title="Estimates"
          subtitle={rows.length ? `${rows.length} line(s) drafted` : 'Quote a party'}
          badge="Quote"
          badgeTone="violet"
        />
      }
      nav={nav}
      refreshControl={
        <RefreshControl refreshing={list.refreshing} onRefresh={list.refresh} tintColor={COLORS.brand} />
      }
      footer={
        <ActionButton
          label={ready ? `Save estimate · ${rupees(total)}` : 'Pick a party and items'}
          tone="brand"
          disabled={!ready}
          loading={create.busy}
          loadingLabel="Saving"
          onPress={create.run}
        />
      }
    >
      <AsyncBoundary
        loading={parties.loading || items.loading}
        error={parties.error || items.error}
        onRetry={() => {
          parties.reload();
          items.reload();
        }}
      >
        <Card title="New quote">
          <Select
            label="Party"
            value={customerId}
            options={(parties.data?.customers || []).map((c) => ({ value: c.masterid, label: c.name }))}
            onChange={setCustomerId}
            placeholder="Choose the party"
          />
          <FormField
            label="Valid for (days)"
            style={styles.spaced}
            value={validity}
            onChangeText={(v) => setValidity(v.replace(/[^0-9]/g, ''))}
            keyboardType="number-pad"
            hint="After this the rates must be re-quoted against current cost"
          />
        </Card>

        <Card title={`Quoted lines (${rows.length})`} flush>
          {rows.map((row, index) => (
            <View key={`${row.item_id}-${index}`} style={[styles.line, index ? styles.ruled : null]}>
              <View style={styles.body}>
                <AppText weight="bold" size="sm">{row.name}</AppText>
                <AppText size="xs" color={COLORS.textSecondary} style={styles.meta}>
                  {`${rupees(row.rate)} each`}
                </AppText>
              </View>
              <FormField
                value={row.qty}
                onChangeText={(v) =>
                  setLines((prev) =>
                    prev.map((l, i) => (i === index ? { ...l, qty: v.replace(/[^0-9.]/g, '') } : l))
                  )
                }
                keyboardType="decimal-pad"
                style={styles.qty}
                inputStyle={styles.qtyInput}
              />
              <AppText weight="bold" size="sm" color={COLORS.brand} style={styles.lineTotal}>
                {rupees(row.total)}
              </AppText>
              <TouchableOpacity
                onPress={() => setLines((prev) => prev.filter((_, i) => i !== index))}
                style={styles.remove}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${row.name}`}
              >
                <AppText weight="bold" size="sm" color={COLORS.error}>✕</AppText>
              </TouchableOpacity>
            </View>
          ))}

          <View style={styles.addWrap}>
            <Select value={picking} options={catalogue} onChange={addLine} placeholder="+ Add an item" />
          </View>
        </Card>

        {rows.length ? (
          <Card flush>
            <DetailRow label="Estimate total" value={rupees(total)} tone="brand" last />
          </Card>
        ) : null}

        <NoticeBar tone="info" glyph="📄">
          An estimate books no stock and creates no ledger entry. Convert it to raise a real order.
        </NoticeBar>

        <AsyncBoundary
          loading={list.loading}
          error={list.error}
          onRetry={list.reload}
          empty={!(list.data?.estimates || []).length}
          emptyText="No quotes yet."
        >
          <Card title="Recent quotes" flush>
            {(list.data?.estimates || []).map((est, index) => (
              <View key={est.id} style={[styles.row, index ? styles.ruled : null]}>
                <View style={styles.body}>
                  <AppText weight="bold" size="sm" numberOfLines={1}>{est.party}</AppText>
                  <AppText size="xs" color={COLORS.textSecondary} style={styles.meta}>
                    {`${rupees(est.total_amount)} · ${formatDate(est.estimate_date)} · ${est.valid_days}d`}
                  </AppText>
                </View>
                {est.status === 'converted' ? (
                  <Badge tone="success">Order #{est.converted_order_id}</Badge>
                ) : (
                  <TouchableOpacity
                    disabled={convert.busy}
                    onPress={() =>
                      confirmAction(
                        'Convert to an order?',
                        `${est.party} — rates are re-read from the item master, so the total may differ from the quote.`,
                        () => convert.run(est.id)
                      )
                    }
                    accessibilityRole="button"
                    accessibilityLabel={`Convert ${est.party}'s quote`}
                  >
                    <AppText weight="bold" size="xs" color={COLORS.primary}>Convert →</AppText>
                  </TouchableOpacity>
                )}
              </View>
            ))}
          </Card>
        </AsyncBoundary>
      </AsyncBoundary>
    </Screen>
  );
}

const styles = StyleSheet.create({
  spaced: { marginTop: 13 },
  line: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 14, gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 14, gap: 10 },
  ruled: { borderTopWidth: 1, borderTopColor: COLORS.borderLight },
  body: { flex: 1 },
  meta: { marginTop: 3 },
  qty: { width: 56 },
  qtyInput: { minHeight: 38, textAlign: 'center', paddingHorizontal: 6 },
  lineTotal: { width: 64, textAlign: 'right' },
  remove: { paddingHorizontal: 4 },
  addWrap: { padding: 14, borderTopWidth: 1, borderTopColor: COLORS.borderLight },
});
