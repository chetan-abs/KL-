import React from 'react';
import { View, RefreshControl, StyleSheet } from 'react-native';

import { useThemeColors } from '../../context/ThemeContext';
import { Git } from '../../services/endpoints';
import { useApi, useAction } from '../../hooks/useApi';
import { rupees, rupeesShort } from '../../utils/format';
import { formatDate, todayString } from '../../utils/datetime';
import { promptText, showAlert } from '../../services/confirm';
import AppText from '../../components/AppText';
import Screen from '../../components/mobile/Screen';
import ScreenHeader from '../../components/mobile/ScreenHeader';
import Card from '../../components/mobile/Card';
import Badge from '../../components/mobile/Badge';
import Field from '../../components/mobile/Field';
import Select from '../../components/mobile/Select';
import NoticeBar from '../../components/mobile/NoticeBar';
import ActionButton from '../../components/mobile/ActionButton';
import AsyncBoundary from '../../components/mobile/AsyncBoundary';

/**
 * Goods in Transit — section 5.2, with the GST-bill tracker of 5.3.
 *
 * The register is sorted by the server so that what is late floats: received
 * consignments sink, and among the rest the earliest expected date comes first.
 * The screen does not re-sort — a second ordering that disagrees with the one
 * the API applied is how a list stops being trustworthy.
 *
 * Freight payable is grouped by transporter rather than shown per bilty,
 * because "what do we owe this transporter" is the question the figures exist
 * to answer; per-consignment freight is on the row that carries it.
 */

const STATUS_TONE = {
  pending: 'neutral',
  arrived: 'pending',
  received: 'success',
  issue: 'danger',
};

/** Mirrors `STAGES` in `backend/routes/git.js`; the server is still the judge. */
const NEXT = {
  pending: [['arrived', 'In Guwahati'], ['received', 'Received'], ['issue', 'Short / damaged']],
  arrived: [['received', 'Received'], ['issue', 'Short / damaged']],
  received: [['issue', 'Short / damaged']],
  issue: [['received', 'Received']],
};

const FREIGHT_OPTIONS = [
  { value: 'to_pay', label: 'To pay — we settle it on arrival' },
  { value: 'paid', label: 'Paid — the supplier has settled it' },
];

export default function GitScreen({ role, nav, onBack }) {
  const COLORS = useThemeColors();
  const styles = React.useMemo(() => StyleSheet.create({
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 14, gap: 10 },
  entry: { paddingVertical: 12, paddingHorizontal: 14, gap: 10 },
  entryHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  ruled: { borderTopWidth: 1, borderTopColor: COLORS.borderLight },
  body: { flex: 1 },
  meta: { marginTop: 3 },
  tail: { alignItems: 'flex-end', gap: 6 },
  stages: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  warn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: COLORS.surfaceLight,
  },
}), [COLORS]);
  const [filter, setFilter] = React.useState('open');
  const [adding, setAdding] = React.useState(false);

  const params = filter === 'overdue' ? { overdue: 'true' }
    : filter === 'open' ? {} : { status: filter };

  const register = useApi(() => Git.register(params), [filter]);
  const gst = useApi(() => Git.gstPending(), []);
  const suppliers = useApi(() => Git.suppliers(), []);

  // ---- record a bilty ----------------------------------------------------
  const [lr, setLr] = React.useState('');
  const [supplierId, setSupplierId] = React.useState('');
  const [supplierName, setSupplierName] = React.useState('');
  const [transporter, setTransporter] = React.useState('');
  const [dispatchDate, setDispatchDate] = React.useState(todayString());
  const [expected, setExpected] = React.useState('');
  const [freightType, setFreightType] = React.useState('to_pay');
  const [freight, setFreight] = React.useState('');

  const record = useAction(
    () => Git.record({
      lr_number: lr.trim(),
      supplier_id: supplierId ? Number(supplierId) : null,
      supplier_name: supplierName.trim() || null,
      transporter_name: transporter.trim() || null,
      dispatch_date: dispatchDate || null,
      expected_date: expected || null,
      freight_type: freightType,
      freight_amount: Number(freight) || 0,
    }),
    {
      onDone: (r) => {
        setAdding(false);
        setLr(''); setSupplierName(''); setTransporter(''); setFreight(''); setExpected('');
        register.reload();
        // The lead-time suggestion is worth saying out loud — it is the only
        // place the supplier's learned transit time becomes visible.
        showAlert('Recorded', r.expected_date
          ? `Expected ${formatDate(r.expected_date)}.`
          : 'No expected date — set one when transport confirms.');
      },
    }
  );

  const stage = useAction(({ id, to, note }) => Git.stage(id, to, note), {
    onDone: register.reload,
  });

  const bill = useAction(({ id, no }) => Git.gstBill(id, no), {
    onDone: () => { gst.reload(); register.reload(); },
  });

  /**
   * 5.2: an issue is a shortage or damage, and the note is what the owner is
   * notified with. A blank one would page Yash with nothing to act on.
   */
  const raiseIssue = (row) => promptText({
    title: `LR ${row.lr_number}`,
    message: 'What is wrong with the consignment? This goes to the owner.',
    placeholder: 'Two cartons short',
    confirmLabel: 'Report',
    destructive: true,
    onSubmit: (note) => stage.run({ id: row.id, to: 'issue', note }),
  });

  const askBill = (row) => promptText({
    title: `GST bill for challan ${row.challan_no || row.id}`,
    message: `${row.supplier_name} — ${rupees(row.grand_total)}.`
      + ' Entering the bill number converts the purchase to a registered one.',
    placeholder: 'Bill number',
    confirmLabel: 'Record',
    onSubmit: (no) => bill.run({ id: row.id, no }),
  });

  const entries = register.data?.entries || [];
  const freightRows = (register.data?.freight_by_transporter || [])
    .filter((f) => Number(f.to_pay) > 0);
  const pendingGst = gst.data?.pending || [];
  const overdueCount = entries.filter((e) => e.days_overdue > 0).length;

  return (
    <Screen
      header={
        <ScreenHeader
          clock=""
          role={role.name}
          title="Goods in Transit"
          subtitle={`${entries.length} consignment${entries.length === 1 ? '' : 's'}`}
          badge={overdueCount ? `${overdueCount} LATE` : 'ON TIME'}
          badgeTone={overdueCount ? 'danger' : 'success'}
          onBack={onBack}
        />
      }
      nav={nav}
      refreshControl={
        <RefreshControl
          refreshing={register.refreshing}
          onRefresh={register.refresh}
          tintColor={COLORS.brand}
        />
      }
      footer={
        <ActionButton
          label={adding ? 'Close the form' : 'Record a bilty'}
          tone={adding ? 'neutral' : 'brand'}
          onPress={() => setAdding((v) => !v)}
        />
      }
    >
      {adding ? (
        <Card title="New bilty">
          <Field label="LR / bilty number" value={lr} onChangeText={setLr} required />
          <Select
            label="Supplier"
            value={supplierId}
            options={(suppliers.data?.suppliers || [])
              .map((s) => ({ value: String(s.id), label: s.name }))}
            onChange={setSupplierId}
            placeholder="Pick a known supplier…"
          />
          {!supplierId ? (
            <Field
              label="…or name a new one"
              value={supplierName}
              onChangeText={setSupplierName}
              placeholder="Supplier name"
            />
          ) : null}
          <Field label="Transporter" value={transporter} onChangeText={setTransporter} />
          <Field
            label="Dispatched on"
            value={dispatchDate}
            onChangeText={setDispatchDate}
            placeholder="YYYY-MM-DD"
          />
          <Field
            label="Expected"
            value={expected}
            onChangeText={setExpected}
            placeholder="Leave blank to use the supplier's lead time"
          />
          <Select
            label="Freight"
            value={freightType}
            options={FREIGHT_OPTIONS}
            onChange={setFreightType}
          />
          <Field
            label="Freight amount"
            value={freight}
            onChangeText={setFreight}
            keyboardType="numeric"
            placeholder="0"
          />
          <ActionButton
            label={record.busy ? 'Recording…' : 'Record'}
            onPress={record.run}
            disabled={record.busy || !lr.trim() || !(supplierId || supplierName.trim())}
          />
          {record.error ? <NoticeBar tone="danger">{record.error}</NoticeBar> : null}
        </Card>
      ) : null}

      {/* 5.3 — the challan purchases whose GST bill has not arrived. Above the
          register because it is time-limited: the window closes. */}
      {pendingGst.length ? (
        <Card title={`GST bill awaited (${pendingGst.length})`} flush>
          {gst.data?.overdue ? (
            <View style={styles.warn}>
              <AppText size="xs" color={COLORS.error}>
                {`${gst.data.overdue} past the due date.`}
              </AppText>
            </View>
          ) : null}
          {pendingGst.slice(0, 10).map((row, index) => (
            <View key={row.id} style={[styles.row, index ? styles.ruled : null]}>
              <View style={styles.body}>
                <AppText weight="bold" size="sm">{row.supplier_name}</AppText>
                <AppText size="xs" color={COLORS.textMuted} style={styles.meta}>
                  {`Challan ${row.challan_no || '—'} · ${rupees(row.grand_total)}`}
                </AppText>
              </View>
              <View style={styles.tail}>
                <Badge tone={Number(row.days_left) < 0 ? 'danger' : 'pending'}>
                  {Number(row.days_left) < 0
                    ? `${Math.abs(row.days_left)}d over`
                    : `${row.days_left}d left`}
                </Badge>
                <ActionButton tone="neutral" size="sm" label="Bill in" onPress={() => askBill(row)} />
              </View>
            </View>
          ))}
        </Card>
      ) : null}

      <View style={styles.filters}>
        {[['open', 'All open'], ['overdue', 'Late'], ['received', 'Received'], ['issue', 'Issues']]
          .map(([key, label]) => (
            <ActionButton
              key={key}
              tone={filter === key ? 'brand' : 'neutral'}
              size="sm"
              label={label}
              onPress={() => setFilter(key)}
            />
          ))}
      </View>

      <AsyncBoundary
        loading={register.loading}
        error={register.error}
        onRetry={register.reload}
        empty={!entries.length}
        emptyGlyph="⛟"
        emptyText="Nothing in transit."
      >
        <Card title="The register" flush>
          {entries.map((row, index) => (
            <View key={row.id} style={[styles.entry, index ? styles.ruled : null]}>
              <View style={styles.entryHead}>
                <View style={styles.body}>
                  <AppText weight="bold" size="sm">
                    {`LR ${row.lr_number} · ${row.supplier_name}`}
                  </AppText>
                  <AppText size="xs" color={COLORS.textMuted} style={styles.meta}>
                    {[
                      row.transporter_name,
                      row.expected_date ? `due ${formatDate(row.expected_date)}` : 'no due date',
                      Number(row.freight_amount) > 0
                        ? `${rupees(row.freight_amount)} ${row.freight_type === 'to_pay' ? 'to pay' : 'paid'}`
                        : null,
                    ].filter(Boolean).join(' · ')}
                  </AppText>
                  {row.note ? (
                    <AppText size="xs" color={COLORS.error} style={styles.meta}>{row.note}</AppText>
                  ) : null}
                </View>
                <Badge tone={row.days_overdue > 0 ? 'danger' : (STATUS_TONE[row.status] || 'neutral')}>
                  {row.days_overdue > 0 ? `${row.days_overdue}d LATE` : row.status.toUpperCase()}
                </Badge>
              </View>

              {role.movesGoods ? (
                <View style={styles.stages}>
                  {(NEXT[row.status] || []).map(([to, label]) => (
                    <ActionButton
                      key={to}
                      tone={to === 'issue' ? 'reject' : 'neutral'}
                      size="sm"
                      label={label}
                      disabled={stage.busy}
                      onPress={() => (to === 'issue'
                        ? raiseIssue(row)
                        : stage.run({ id: row.id, to }))}
                    />
                  ))}
                </View>
              ) : null}
            </View>
          ))}
        </Card>

        {freightRows.length ? (
          <Card title="Freight payable" flush>
            {freightRows.map((f, index) => (
              <View key={f.transporter} style={[styles.row, index ? styles.ruled : null]}>
                <View style={styles.body}>
                  <AppText weight="bold" size="sm">{f.transporter}</AppText>
                  <AppText size="xs" color={COLORS.textMuted} style={styles.meta}>
                    {`${f.consignments} consignment${Number(f.consignments) === 1 ? '' : 's'}`}
                  </AppText>
                </View>
                <AppText weight="bold" size="sm" color={COLORS.error}>
                  {rupeesShort(f.to_pay)}
                </AppText>
              </View>
            ))}
          </Card>
        ) : null}
      </AsyncBoundary>
    </Screen>
  );
}

