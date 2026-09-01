import React from 'react';
import { View, RefreshControl, StyleSheet, Linking } from 'react-native';

import { useThemeColors } from '../../context/ThemeContext';
import { Reports } from '../../services/endpoints';
import { useApi } from '../../hooks/useApi';
import { rupees, rupeesShort } from '../../utils/format';
import { todayString, addDays, formatDate } from '../../utils/datetime';
import AppText from '../../components/AppText';
import Screen from '../../components/mobile/Screen';
import ScreenHeader from '../../components/mobile/ScreenHeader';
import Card from '../../components/mobile/Card';
import Badge from '../../components/mobile/Badge';
import Select from '../../components/mobile/Select';
import ActionButton from '../../components/mobile/ActionButton';
import AsyncBoundary from '../../components/mobile/AsyncBoundary';

/**
 * Reports — section 12.
 *
 * One screen for all twelve rather than twelve screens, because they share
 * everything that matters: a date range defaulting to today, a table, and two
 * export buttons. Twelve near-identical screens would be twelve places to fix
 * the next time the range control changes.
 *
 * The report picker is a Select rather than tabs: twelve tabs do not fit on a
 * phone, and the list is read once and chosen from, not switched between
 * constantly.
 *
 * Export is a link, not a fetch. Pulling a 5,000-row PDF through the client
 * into memory to hand it to a download is work for nothing, and the browser
 * already knows how to save a file.
 */

/** The twelve, with the columns worth showing on a phone. */
const REPORTS = [
  {
    key: 'daily-sales',
    label: 'Daily Sales',
    ranged: true,
    fetch: (p) => Reports.dailySales(p),
    columns: [['party', 'Party'], ['so_number', 'SO'], ['total_amount', 'Value', 'money']],
    summary: (m, rows) => [
      ['Orders', rows.length],
      ['Value', rupeesShort(rows.reduce((a, r) => a + Number(r.total_amount || 0), 0))],
    ],
  },
  {
    key: 'outstanding',
    label: 'Outstanding',
    fetch: () => Reports.outstanding(),
    columns: [['party', 'Party'], ['b60_plus', '60+ days', 'money'], ['total', 'Total', 'money']],
    summary: (m) => [
      ['0–30', rupeesShort(m?.totals?.b0_30)],
      ['31–60', rupeesShort(m?.totals?.b31_60)],
      ['60+', rupeesShort(m?.totals?.b60_plus)],
    ],
  },
  {
    // 8 — "bill-wise, never party totals only." A party-level total hides
    // one very old bill behind five new ones; this is the row-per-invoice
    // view the sheet asks for, alongside (not replacing) the party summary
    // above, which section 12 already specifies by that name.
    key: 'outstanding-bills',
    label: 'Outstanding (Bill-wise)',
    fetch: (p) => Reports.outstandingBills(p),
    columns: [['invoice_no', 'Invoice'], ['party', 'Party'], ['bucket', 'Bucket'], ['outstanding', 'Outstanding', 'money']],
    summary: (m, rows) => [
      ['Bills', rows.length],
      ['Total', rupeesShort(m?.total)],
    ],
  },
  {
    key: 'salesman-performance',
    label: 'Salesman Performance',
    ranged: true,
    fetch: (p) => Reports.salesmanPerformance(p),
    columns: [['salesman', 'Salesman'], ['orders_placed', 'Orders'], ['order_value', 'Value', 'money']],
  },
  {
    key: 'purchases',
    label: 'Purchase',
    ranged: true,
    fetch: (p) => Reports.purchases(p),
    columns: [['supplier_name', 'Supplier'], ['bill_qty', 'Billed'], ['actual_qty', 'Actual']],
  },
  {
    key: 'stock',
    label: 'Stock below minimum',
    fetch: () => Reports.stock({ below_minimum: true }),
    columns: [['name', 'Item'], ['qty', 'In stock'], ['shortfall', 'Short by']],
  },
  {
    key: 'cheques',
    label: 'Cheque',
    fetch: () => Reports.cheques(),
    columns: [['party', 'Party'], ['cheque_no', 'Cheque'], ['amount', 'Amount', 'money']],
  },
  {
    key: 'cash-discount',
    label: 'Cash Discount',
    ranged: true,
    fetch: (p) => Reports.cashDiscount(p),
    columns: [['party', 'Party'], ['note_no', 'Note'], ['amount', 'Discount', 'money']],
  },
  {
    key: 'estimate-conversion',
    label: 'Estimate Conversion',
    ranged: true,
    fetch: (p) => Reports.estimateConversion(p),
    columns: [['party', 'Party'], ['status', 'Status'], ['total_amount', 'Value', 'money']],
    summary: (m) => [
      ['Created', m?.counts?.created],
      ['Converted', m?.counts?.converted],
      ['Rate', m?.conversion_rate === null ? '—' : `${m?.conversion_rate}%`],
    ],
  },
  {
    key: 'stock-counts',
    label: 'Stock Count',
    ranged: true,
    fetch: (p) => Reports.stockCounts(p),
    columns: [['item_name', 'Item'], ['system_qty', 'System'], ['counted_qty', 'Counted']],
    summary: (m) => [
      ['Counted', m?.lines_counted],
      ['Mismatch', m?.mismatches],
      ['Accuracy', m?.accuracy === null ? '—' : `${m?.accuracy}%`],
    ],
  },
];

export default function ReportsScreen({ role, nav, onBack }) {
  const COLORS = useThemeColors();
  const styles = React.useMemo(() => StyleSheet.create({
  ranges: { flexDirection: 'row', gap: 8 },
  summary: { flexDirection: 'row', justifyContent: 'space-around' },
  figure: { alignItems: 'center', gap: 2 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 14, gap: 10 },
  ruled: { borderTopWidth: 1, borderTopColor: COLORS.borderLight },
  body: { flex: 1 },
  meta: { marginTop: 3 },
  more: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderTopWidth: 1,
    borderTopColor: COLORS.borderLight,
    backgroundColor: COLORS.surfaceLight,
  },
  exports: { flexDirection: 'row', gap: 10 },
  half: { flex: 1 },
}), [COLORS]);
  const [key, setKey] = React.useState('daily-sales');
  // Section 12: "Default date range for all reports is today."
  const [from, setFrom] = React.useState(todayString());
  const [to, setTo] = React.useState(todayString());

  const report = REPORTS.find((r) => r.key === key) || REPORTS[0];
  const params = report.ranged ? { from, to } : {};

  const { data, loading, error, refreshing, reload, refresh } = useApi(
    () => report.fetch(params),
    [key, from, to]
  );

  const rows = data?.rows || [];
  const summary = report.summary ? report.summary(data, rows) : null;

  const openExport = (format) => Linking.openURL(Reports.exportUrl(key, params, format));

  // Whole-week and whole-month shortcuts, because "since the 1st" and "the last
  // seven days" are what people actually ask for and typing two dates on a
  // phone to get them is the slow path.
  const setRange = (days) => {
    setTo(todayString());
    setFrom(days === 0 ? todayString() : addDays(todayString(), -days));
  };

  return (
    <Screen
      header={
        <ScreenHeader
          clock=""
          role={role.name}
          title="Reports"
          subtitle={report.ranged
            ? (from === to ? formatDate(from) : `${formatDate(from)} – ${formatDate(to)}`)
            : 'as at today'}
          badge={`${rows.length}`}
          badgeTone="neutral"
          onBack={onBack}
        />
      }
      nav={nav}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={COLORS.brand} />
      }
      footer={
        <View style={styles.exports}>
          <ActionButton
            tone="neutral"
            label="Excel (CSV)"
            onPress={() => openExport('csv')}
            style={styles.half}
          />
          <ActionButton
            tone="neutral"
            label="PDF"
            onPress={() => openExport('pdf')}
            style={styles.half}
          />
        </View>
      }
    >
      <Select
        label="Report"
        value={key}
        options={REPORTS.map((r) => ({ value: r.key, label: r.label }))}
        onChange={setKey}
      />

      {report.ranged ? (
        <Card title="Period">
          <View style={styles.ranges}>
            <ActionButton tone="neutral" size="sm" label="Today" onPress={() => setRange(0)} />
            <ActionButton tone="neutral" size="sm" label="7 days" onPress={() => setRange(6)} />
            <ActionButton tone="neutral" size="sm" label="30 days" onPress={() => setRange(29)} />
          </View>
        </Card>
      ) : null}

      <AsyncBoundary
        loading={loading}
        error={error}
        onRetry={reload}
        empty={!rows.length}
        emptyGlyph="▤"
        emptyText="No records in this period."
      >
        {summary ? (
          <Card title="Summary">
            <View style={styles.summary}>
              {summary.map(([label, value]) => (
                <View key={label} style={styles.figure}>
                  <AppText weight="bold" size="lg">{value ?? '—'}</AppText>
                  <AppText size="xs" color={COLORS.textMuted}>{label}</AppText>
                </View>
              ))}
            </View>
          </Card>
        ) : null}

        <Card title={report.label} flush>
          {/* Capped on screen, not in the export. A phone list of 2,000 rows is
              not read; the CSV and the PDF carry everything. */}
          {rows.slice(0, 100).map((row, index) => (
            <View key={index} style={[styles.row, index ? styles.ruled : null]}>
              <View style={styles.body}>
                <AppText weight="bold" size="sm" numberOfLines={1}>
                  {row[report.columns[0][0]] ?? '—'}
                </AppText>
                <AppText size="xs" color={COLORS.textMuted} style={styles.meta}>
                  {report.columns.slice(1, 2).map(([k, label, fmt]) =>
                    `${label} ${fmt === 'money' ? rupees(row[k]) : (row[k] ?? '—')}`).join(' · ')}
                </AppText>
              </View>
              {report.columns[2] ? (
                <AppText weight="bold" size="sm">
                  {report.columns[2][2] === 'money'
                    ? rupees(row[report.columns[2][0]])
                    : (row[report.columns[2][0]] ?? '—')}
                </AppText>
              ) : null}
            </View>
          ))}

          {rows.length > 100 ? (
            <View style={styles.more}>
              <AppText size="xs" color={COLORS.textMuted}>
                {`${rows.length - 100} more rows — export to see them all.`}
              </AppText>
            </View>
          ) : null}
        </Card>
      </AsyncBoundary>
    </Screen>
  );
}

