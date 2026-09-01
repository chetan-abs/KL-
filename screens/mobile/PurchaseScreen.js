import React from 'react';
import { View, TouchableOpacity, RefreshControl, StyleSheet } from 'react-native';

import { useThemeColors } from '../../context/ThemeContext';
import { Purchases, Items } from '../../services/endpoints';
import { useApi, useAction } from '../../hooks/useApi';
import { rupees } from '../../utils/format';
import { formatDate } from '../../utils/datetime';
import { confirmAction, showAlert } from '../../services/confirm';
import AppText from '../../components/AppText';
import Screen from '../../components/mobile/Screen';
import ScreenHeader from '../../components/mobile/ScreenHeader';
import Card from '../../components/mobile/Card';
import DetailRow from '../../components/mobile/DetailRow';
import Field from '../../components/mobile/Field';
import Select from '../../components/mobile/Select';
import Badge from '../../components/mobile/Badge';
import ActionButton from '../../components/mobile/ActionButton';
import NoticeBar from '../../components/mobile/NoticeBar';
import AsyncBoundary from '../../components/mobile/AsyncBoundary';

/**
 * 13 — Sonu enters a purchase. Receiving stock is the only thing that adds to
 * the ledger without an order behind it.
 *
 * Posting writes `receipt` movements and recomputes items.qty in the same
 * transaction; items.qty is a cache of that ledger and is never written on its
 * own. It cannot be un-posted — a correction is a new adjustment — which is why
 * the confirmation says so before committing.
 *
 * The rate is captured per line against what the item was last bought at, so a
 * supplier's move is noticed while the docket is being keyed rather than on the
 * alerts screen a day later.
 */
export default function PurchaseScreen({ role, nav, onNewItem, onOpenGit, onOpenTransfers }) {
  const COLORS = useThemeColors();
  const styles = React.useMemo(() => StyleSheet.create({
  flex: { flex: 1 },
  spaced: { marginTop: 13 },
  line: { paddingVertical: 13, paddingHorizontal: 14 },
  ruled: { borderTopWidth: 1, borderTopColor: COLORS.borderLight },
  lineHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  inputs: { flexDirection: 'row', alignItems: 'flex-end', gap: 9, marginTop: 10 },
  remove: { paddingHorizontal: 10, paddingVertical: 13 },
  addWrap: { padding: 14, borderTopWidth: 1, borderTopColor: COLORS.borderLight },
  newItem: { marginTop: 11, alignItems: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 14, gap: 10 },
  meta: { marginTop: 3 },
}), [COLORS]);
  const history = useApi(() => Purchases.list(), []);
  const items = useApi(() => Items.list({ limit: 200 }), []);

  const [supplier, setSupplier] = React.useState('');
  const [invoiceNo, setInvoiceNo] = React.useState('');
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
      { item_id: master.masterid, name: master.name, qty: '', rate: '' },
    ]);
    setPicking(null);
  }

  const setLine = (index, patch) =>
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));

  const subTotal = lines.reduce(
    (sum, l) => sum + (Number(l.qty) || 0) * (Number(l.rate) || 0),
    0
  );

  const ready =
    supplier.trim() &&
    invoiceNo.trim() &&
    lines.length > 0 &&
    lines.every((l) => Number(l.qty) > 0 && Number(l.rate) >= 0);

  const post = useAction(
    () =>
      Purchases.post({
        supplier_name: supplier.trim(),
        invoice_no: invoiceNo.trim(),
        lines: lines.map((l) => ({ item_id: l.item_id, qty: Number(l.qty), rate: Number(l.rate) })),
      }),
    {
      onDone: (result) => {
        showAlert(
          'Purchase posted',
          `${rupees(result.grand_total, { decimals: 'auto' })} received.${
            result.rate_rises ? ` ${result.rate_rises} rate rise flagged.` : ''
          }`
        );
        setSupplier('');
        setInvoiceNo('');
        setLines([]);
        history.reload();
      },
      onFail: (message) => showAlert('Could not post', message),
    }
  );

  return (
    <Screen
      header={
        <ScreenHeader
          clock=""
          role={role.name}
          title="Purchase Entry"
          subtitle={lines.length ? `${lines.length} line(s)` : 'Receive stock'}
          badge={lines.length ? 'Draft' : 'New'}
          badgeTone={lines.length ? 'pending' : 'onBrand'}
        />
      }
      nav={nav}
      refreshControl={
        <RefreshControl refreshing={history.refreshing} onRefresh={history.refresh} tintColor={COLORS.brand} />
      }
      footer={
        <ActionButton
          label={ready ? `Post to Stock Ledger · ${rupees(subTotal)}` : 'Fill the docket to post'}
          tone="brand"
          disabled={!ready}
          loading={post.busy}
          loadingLabel="Posting"
          onPress={() =>
            confirmAction(
              'Post this purchase?',
              `${lines.length} line(s) from ${supplier.trim()}. Stock is added to the ledger and cannot be un-posted — a correction is a new adjustment.`,
              post.run
            )
          }
        />
      }
    >
      <Card title="Supplier">
        <Field label="Supplier name" required value={supplier} onChangeText={setSupplier} placeholder="e.g. Polycab India Ltd" />
        <Field
          label="Their invoice number"
          required
          style={styles.spaced}
          value={invoiceNo}
          onChangeText={setInvoiceNo}
          placeholder="e.g. PI-88421"
          hint="One supplier cannot bill the same number twice"
        />
      </Card>

      <Card title={`Items received (${lines.length})`} flush>
        {lines.map((line, index) => (
          <View key={`${line.item_id}-${index}`} style={[styles.line, index ? styles.ruled : null]}>
            <View style={styles.lineHead}>
              <AppText weight="bold" size="sm" style={styles.flex}>{line.name}</AppText>
              <AppText weight="bold" size="sm" color={COLORS.brand}>
                {rupees((Number(line.qty) || 0) * (Number(line.rate) || 0))}
              </AppText>
            </View>
            <View style={styles.inputs}>
              <Field
                label="Qty"
                style={styles.flex}
                value={line.qty}
                onChangeText={(v) => setLine(index, { qty: v.replace(/[^0-9.]/g, '') })}
                keyboardType="decimal-pad"
              />
              <Field
                label="Rate"
                style={styles.flex}
                value={line.rate}
                onChangeText={(v) => setLine(index, { rate: v.replace(/[^0-9.]/g, '') })}
                keyboardType="decimal-pad"
              />
              <TouchableOpacity
                style={styles.remove}
                onPress={() => setLines((prev) => prev.filter((_, i) => i !== index))}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${line.name}`}
              >
                <AppText weight="bold" size="sm" color={COLORS.error}>✕</AppText>
              </TouchableOpacity>
            </View>
          </View>
        ))}

        <View style={styles.addWrap}>
          <Select
            value={picking}
            options={catalogue}
            onChange={addLine}
            placeholder="+ Add an item"
          />
          {/* Reached from here rather than the tab bar: creating an item is
              something you discover you need mid-docket, when what arrived is
              not yet in the master. */}
          <TouchableOpacity
            style={styles.newItem}
            onPress={onNewItem}
            accessibilityRole="button"
            accessibilityLabel="Create a new item in the master"
          >
            <AppText weight="bold" size="xs" color={COLORS.primary}>
              Not in the master? Create an item →
            </AppText>
          </TouchableOpacity>
        </View>
      </Card>

      {lines.length ? (
        <Card flush>
          <DetailRow label="Sub total" value={rupees(subTotal)} tone="brand" last />
        </Card>
      ) : null}

      <AsyncBoundary
        loading={history.loading}
        error={history.error}
        onRetry={history.reload}
        empty={!(history.data?.purchases || []).length}
        emptyText="No purchases entered yet."
      >
        <Card title="Recent dockets" flush>
          {(history.data?.purchases || []).slice(0, 8).map((row, index) => (
            <View key={row.id} style={[styles.row, index ? styles.ruled : null]}>
              <View style={styles.flex}>
                <AppText weight="bold" size="sm" numberOfLines={1}>{row.supplier_name}</AppText>
                <AppText size="xs" color={COLORS.textSecondary} style={styles.meta}>
                  {`${row.invoice_no} · ${formatDate(row.purchase_date)}`}
                </AppText>
              </View>
              <Badge tone={row.status === 'posted' ? 'success' : 'pending'}>
                {rupees(row.grand_total, { decimals: 'auto' })}
              </Badge>
            </View>
          ))}
        </Card>
      </AsyncBoundary>

      {/* The two registers either side of a purchase: what is still on its way
          here, and what has moved between our own two premises. Both are
          Sonu's, and neither has earned one of the five tab slots against the
          docket he fills in every day. */}
      {onOpenGit ? (
        <ActionButton tone="neutral" label="Goods in transit" onPress={onOpenGit} />
      ) : null}
      {onOpenTransfers ? (
        <ActionButton tone="neutral" label="Internal transfers" onPress={onOpenTransfers} />
      ) : null}
    </Screen>
  );
}

