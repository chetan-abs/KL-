import React from 'react';
import { View, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';

import { COLORS } from '../../constants/colors';
import { Items } from '../../services/endpoints';
import { useApi, useAction } from '../../hooks/useApi';
import { userCan } from '../../utils/permissions';
import { rupees } from '../../utils/format';
import { confirmAction, showAlert } from '../../services/confirm';
import AppText from '../../components/AppText';
import Screen from '../../components/mobile/Screen';
import ScreenHeader from '../../components/mobile/ScreenHeader';
import Card from '../../components/mobile/Card';
import Field from '../../components/mobile/Field';
import ActionButton from '../../components/mobile/ActionButton';
import NoticeBar from '../../components/mobile/NoticeBar';
import AsyncBoundary from '../../components/mobile/AsyncBoundary';

const PAGE_SIZE = 50;

/** `0.52` → `52%`. The sheet stores every discount and ratio as a fraction. */
function pct(value) {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value) * 100;
  return `${Number.isInteger(n) ? n : n.toFixed(1)}%`;
}

/**
 * The 24 columns of the rate sheet's own header row, in the sheet's own
 * order, matched to the `items` columns `KL_LAYOUT.map` writes them into
 * (`backend/scripts/import-rates.js`).
 *
 * Three named columns are not stored as a live cell and are shown as such
 * rather than guessed at:
 *   Sl. No.         — the row's position in that sheet, not a stored fact.
 *                     Shown as this table's own row number instead.
 *   Opening Balance — written once, as a stock movement, the moment an item
 *                     is first created. `items.qty` is what it becomes; there
 *                     is no column left holding the original figure.
 *   per (col. 18)   — sits between the four NET ratios and Opening Balance in
 *                     the sheet, and `KL_LAYOUT.map` has no field at that
 *                     position — nothing in `items` was ever meant to hold it.
 */
const COLUMNS = [
  { key: 'sl', label: 'Sl. No.', width: 56, render: (i, row) => String(row) },
  { key: 'name', label: 'Name of Item', width: 240, render: (i) => i.name },
  { key: 'under', label: 'Under', width: 150, render: (i) => i.category || i.brand || '—' },
  { key: 'code', label: 'Item Code', width: 90, render: (i) => i.code || '—' },
  { key: 'unit', label: 'Units', width: 70, render: (i) => i.unit || '—' },
  { key: 'min_stock', label: 'Minimum Stock', width: 100, render: (i) => i.min_stock ?? '—' },
  { key: 'pricing_type', label: 'Pricing Type', width: 110, render: (i) => i.pricing_type || '—' },
  { key: 'base_price', label: 'Dealer Price', width: 100, render: (i) => (i.base_price != null ? rupees(i.base_price) : '—') },
  { key: 'disc_dealer', label: 'Dealer Good Discount', width: 130, render: (i) => pct(i.disc_dealer) },
  { key: 'disc_builder_direct', label: 'Builder Direct Discount', width: 140, render: (i) => pct(i.disc_builder_direct) },
  { key: 'disc_builder_comm', label: 'Builder Commission Discount', width: 160, render: (i) => pct(i.disc_builder_comm) },
  { key: 'disc_retail_direct', label: 'Retail Direct Discount', width: 130, render: (i) => pct(i.disc_retail_direct) },
  { key: 'disc_retail_comm', label: 'Retail Commission Discount', width: 155, render: (i) => pct(i.disc_retail_comm) },
  { key: 'ratio_builder_direct', label: 'Builder Direct Ratio (NET)', width: 150, render: (i) => pct(i.ratio_builder_direct) },
  { key: 'ratio_builder_comm', label: 'Builder Commission Ratio (NET)', width: 170, render: (i) => pct(i.ratio_builder_comm) },
  { key: 'ratio_retail_direct', label: 'Retail Direct Ratio (NET)', width: 145, render: (i) => pct(i.ratio_retail_direct) },
  { key: 'ratio_retail_comm', label: 'Retail Commission Ratio (NET)', width: 165, render: (i) => pct(i.ratio_retail_comm) },
  { key: 'per', label: 'per', width: 60, render: () => '—' },
  { key: 'opening_balance', label: 'Opening Balance', width: 110, render: () => '—' },
  { key: 'comm_retail_agent', label: 'Retail Agent Commission %', width: 150, render: (i) => pct(i.comm_retail_agent) },
  { key: 'comm_builder_agent', label: 'Builder Agent Commission %', width: 155, render: (i) => pct(i.comm_builder_agent) },
  { key: 'disc_electrician', label: 'Electrician Direct Discount', width: 155, render: (i) => pct(i.disc_electrician) },
  { key: 'ratio_electrician', label: 'Electrician Direct Ratio (NET)', width: 165, render: (i) => pct(i.ratio_electrician) },
  { key: 'scheme_weightage', label: 'Scheme Weightage', width: 130, render: (i) => pct(i.scheme_weightage) },
];
const TABLE_WIDTH = COLUMNS.reduce((sum, c) => sum + c.width, 0);

/**
 * The item catalog: an add-only spreadsheet import at the top, a searchable
 * table underneath.
 *
 * "I upload the excel, they fetch the data and add to the table, and always
 * I upload it they compare with the new one and those are missing they add,
 * rest of them ignore" — so import here never overwrites a price. Correcting
 * one is a row edit below, which goes through the same `PUT /api/items/:id`
 * every other rate edit uses — R-04 and R-11 hold exactly as they do
 * everywhere else: Gaurav's edit here queues for Yash or Manoj too.
 */
export default function ItemCatalogScreen({ role, user, nav, onBack }) {
  const [search, setSearch] = React.useState('');
  const [page, setPage] = React.useState(0);
  const [openId, setOpenId] = React.useState(null);
  const [draft, setDraft] = React.useState({});
  const [picked, setPicked] = React.useState(null);

  const canImport = userCan(user, 'all');
  const canEditRates = userCan(user, 'items') || userCan(user, 'items.pricing');
  const canEditMaster = userCan(user, 'items') || userCan(user, 'items.edit');

  const { data, loading, error, reload } = useApi(
    () => Items.list({ search: search.trim() || undefined, limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
    [search, page]
  );
  const items = data?.items || [];
  const total = data?.total || 0;

  const pick = useAction(
    async () => {
      const result = await DocumentPicker.getDocumentAsync({
        type: [
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'application/vnd.ms-excel',
        ],
        copyToCacheDirectory: true,
      });
      if (result.canceled) return null;
      const asset = result.assets?.[0];
      if (!asset) return null;

      const response = await fetch(asset.uri);
      const blob = await response.blob();
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(String(reader.result).split(',')[1] || '');
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      setPicked({ name: asset.name, base64 });
      return asset.name;
    },
    { onFail: (message) => showAlert('Could not read that file', message) }
  );

  const doImport = useAction(
    () => Items.import({ base64: picked.base64, filename: picked.name }),
    {
      onDone: (result) => {
        setPicked(null);
        showAlert(
          result.created ? 'Import complete' : 'Nothing new',
          result.message
            + (result.unpriced ? `\n\n${result.unpriced} new row(s) carry no pricing type and cannot be sold yet.` : '')
        );
        reload();
      },
      onFail: (message) => showAlert('Import failed', message),
    }
  );

  const save = useAction(
    ({ id, payload }) => Items.update(id, payload),
    {
      onDone: (result) => {
        setOpenId(null);
        setDraft({});
        showAlert(
          result?.code === 'RATE_CHANGE_PENDING' ? 'Sent for approval' : 'Saved',
          result?.code === 'RATE_CHANGE_PENDING'
            ? 'Gaurav\'s rate edits need Yash or Manoj to approve — R-11. It will show once decided.'
            : 'Updated.'
        );
        reload();
      },
      onFail: (message) => showAlert('Could not save', message),
    }
  );

  function open(item) {
    if (openId === item.masterid) {
      setOpenId(null);
      setDraft({});
      return;
    }
    setOpenId(item.masterid);
    setDraft({
      base_price: item.base_price != null ? String(item.base_price) : '',
      disc_dealer: item.disc_dealer != null ? String(item.disc_dealer) : '',
      cost_price: item.cost_price != null ? String(item.cost_price) : '',
      gst_percent: item.gst_percent != null ? String(item.gst_percent) : '',
      hsn: item.hsn || '',
      godown: item.godown || '',
      rack: item.rack || '',
    });
  }

  function submit(item) {
    const payload = {};
    if (canEditRates) {
      if (draft.base_price !== '') payload.base_price = Number(draft.base_price);
      if (draft.disc_dealer !== '') payload.disc_dealer = Number(draft.disc_dealer);
      if (draft.cost_price !== '') payload.cost_price = Number(draft.cost_price);
    }
    if (canEditMaster) {
      payload.gst_percent = draft.gst_percent === '' ? null : Number(draft.gst_percent);
      payload.hsn = draft.hsn || null;
      payload.godown = draft.godown || null;
      payload.rack = draft.rack || null;
    }
    confirmAction(
      `Save ${item.name}?`,
      canEditRates && userCan(user, 'all')
        ? 'Applies immediately — you are an owner.'
        : canEditRates
          ? 'Rate fields go to Yash or Manoj for approval (R-11). Master fields (GST, HSN, rack) save immediately.'
          : 'Saves immediately.',
      () => save.run({ id: item.masterid, payload })
    );
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <Screen
      nav={nav}
      header={
        <ScreenHeader
          role={role.name}
          title="Item Catalog"
          subtitle={`${total.toLocaleString('en-IN')} items`}
          onBack={onBack}
        />
      }
    >
      {canImport ? (
        <Card title="Import rate card — add only">
          <NoticeBar tone="info">
            An item already in the catalog is never changed here. Only a name the sheet has and the
            catalog does not gets added.
          </NoticeBar>
          <TouchableOpacity
            style={styles.picker}
            onPress={pick.run}
            activeOpacity={0.75}
            accessibilityRole="button"
          >
            <AppText size="sm" color={picked ? COLORS.text : COLORS.textMuted}>
              {pick.busy ? 'Reading…' : picked ? picked.name : 'Choose an .xlsx file'}
            </AppText>
          </TouchableOpacity>
          <ActionButton
            label="Import"
            tone="teal"
            style={styles.spaced}
            disabled={!picked}
            loading={doImport.busy}
            loadingLabel="Importing"
            onPress={doImport.run}
          />
        </Card>
      ) : null}

      <Card title="Search" flush>
        <View style={styles.searchRow}>
          <Field
            value={search}
            onChangeText={(v) => { setSearch(v); setPage(0); }}
            placeholder="Item name, code, brand, HSN…"
            style={styles.searchField}
          />
        </View>
      </Card>

      <AsyncBoundary
        loading={loading}
        error={error}
        onRetry={reload}
        empty={!items.length}
        emptyText="No items match."
      >
        <Card title={`Items (page ${page + 1} of ${totalPages})`} flush bodyStyle={styles.tableBody}>
          <ScrollView horizontal showsHorizontalScrollIndicator>
            <View style={{ width: TABLE_WIDTH }}>
              <View style={styles.headerRow}>
                {COLUMNS.map((col) => (
                  <View key={col.key} style={[styles.cell, { width: col.width }]}>
                    <AppText weight="bold" size={10} color={COLORS.textSecondary} numberOfLines={2}>
                      {col.label}
                    </AppText>
                  </View>
                ))}
              </View>

              {items.map((item, index) => {
                const isOpen = openId === item.masterid;
                return (
                  <TouchableOpacity
                    key={item.masterid}
                    style={[
                      styles.dataRow,
                      index % 2 ? styles.rowAlt : null,
                      isOpen ? styles.rowOpen : null,
                    ]}
                    onPress={() => open(item)}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                  >
                    {COLUMNS.map((col) => (
                      <View key={col.key} style={[styles.cell, { width: col.width }]}>
                        <AppText size={11} numberOfLines={1}>
                          {col.render(item, page * PAGE_SIZE + index + 1)}
                        </AppText>
                      </View>
                    ))}
                  </TouchableOpacity>
                );
              })}
            </View>
          </ScrollView>
        </Card>

        {openId ? (() => {
          const item = items.find((i) => i.masterid === openId);
          if (!item) return null;
          return (
            <Card title={`Edit — ${item.name}`}>
              {canEditRates ? (
                <>
                  <AppText weight="bold" size={11} color={COLORS.textSecondary} style={styles.sectionLabel}>
                    RATE — R-04 / R-11
                  </AppText>
                  <Field
                    label="Base price / Dealer Price (₹)"
                    value={draft.base_price}
                    onChangeText={(v) => setDraft((d) => ({ ...d, base_price: v }))}
                    keyboardType="numeric"
                  />
                  <Field
                    label="Dealer Good Discount (0–1)"
                    style={styles.spaced}
                    value={draft.disc_dealer}
                    onChangeText={(v) => setDraft((d) => ({ ...d, disc_dealer: v }))}
                    keyboardType="numeric"
                    hint="Fraction, e.g. 0.52 for 52%"
                  />
                  <Field
                    label="Cost price (₹) — R-16"
                    style={styles.spaced}
                    value={draft.cost_price}
                    onChangeText={(v) => setDraft((d) => ({ ...d, cost_price: v }))}
                    keyboardType="numeric"
                  />
                </>
              ) : null}
              {canEditMaster ? (
                <>
                  <AppText weight="bold" size={11} color={COLORS.textSecondary} style={styles.sectionLabel}>
                    MASTER
                  </AppText>
                  <Field
                    label="GST %"
                    value={draft.gst_percent}
                    onChangeText={(v) => setDraft((d) => ({ ...d, gst_percent: v }))}
                    keyboardType="numeric"
                  />
                  <Field
                    label="HSN code"
                    style={styles.spaced}
                    value={draft.hsn}
                    onChangeText={(v) => setDraft((d) => ({ ...d, hsn: v }))}
                  />
                  <Field
                    label="Godown"
                    style={styles.spaced}
                    value={draft.godown}
                    onChangeText={(v) => setDraft((d) => ({ ...d, godown: v }))}
                  />
                  <Field
                    label="Rack"
                    style={styles.spaced}
                    value={draft.rack}
                    onChangeText={(v) => setDraft((d) => ({ ...d, rack: v }))}
                  />
                </>
              ) : null}
              {!canEditRates && !canEditMaster ? (
                <AppText size="sm" color={COLORS.textSecondary}>
                  You do not hold a grant that edits this item.
                </AppText>
              ) : (
                <ActionButton
                  label="Save"
                  tone="brand"
                  size="sm"
                  style={styles.spaced}
                  loading={save.busy}
                  onPress={() => submit(item)}
                />
              )}
            </Card>
          );
        })() : null}

        <View style={styles.pageRow}>
          <ActionButton
            tone="neutral" size="sm" label="‹ Prev"
            disabled={page === 0}
            onPress={() => setPage((p) => Math.max(0, p - 1))}
          />
          <AppText size="sm" color={COLORS.textSecondary}>{`Page ${page + 1} / ${totalPages}`}</AppText>
          <ActionButton
            tone="neutral" size="sm" label="Next ›"
            disabled={page + 1 >= totalPages}
            onPress={() => setPage((p) => p + 1)}
          />
        </View>
      </AsyncBoundary>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  spaced: { marginTop: 11 },
  searchRow: { padding: 4 },
  searchField: { margin: 0 },
  picker: {
    marginTop: 11, borderWidth: 1, borderStyle: 'dashed', borderColor: COLORS.border,
    borderRadius: 9, padding: 14, alignItems: 'center',
  },
  tableBody: { padding: 0 },
  headerRow: {
    flexDirection: 'row', backgroundColor: COLORS.surfaceLight,
    borderBottomWidth: 1, borderBottomColor: COLORS.border,
  },
  dataRow: {
    flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: COLORS.borderLight,
  },
  rowAlt: { backgroundColor: COLORS.surfaceLight },
  rowOpen: { backgroundColor: COLORS.infoSurface },
  cell: { paddingVertical: 10, paddingHorizontal: 8, justifyContent: 'center' },
  sectionLabel: { letterSpacing: 0.6, marginBottom: 8, marginTop: 4 },
  pageRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 4,
  },
});
