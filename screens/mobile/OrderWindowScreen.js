import React from 'react';
import { View, TouchableOpacity, StyleSheet } from 'react-native';

import { useThemeColors } from '../../context/ThemeContext';
import { Orders, Items, Customers } from '../../services/endpoints';
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
import ActionButton from '../../components/mobile/ActionButton';
import NoticeBar from '../../components/mobile/NoticeBar';
import AsyncBoundary from '../../components/mobile/AsyncBoundary';

/**
 * 04 — The order window.
 *
 * Quantity, discount and scheme are the salesman's to set. The rate is not: it
 * is shown read-only from the item master, and the server takes its own copy
 * inside the order transaction, so a crafted request cannot book stock at a
 * price it chose. The figures here are a preview — the server's totals are the
 * ones that count.
 *
 * `scheme` is captured for reporting on what was promised in the field and is
 * deliberately excluded from the total: it means free goods agreed separately,
 * not a second discount.
 *
 * A no-order visit is its own button, not a cancelled order. Reusing
 * "cancelled" made a genuine cancellation indistinguishable from a call that
 * produced nothing, so every cancellation was reported as an unproductive visit
 * and dropped out of sales.
 */
export default function OrderWindowScreen({ role, onBack, onSaved, nav}) {
  const COLORS = useThemeColors();
  const styles = React.useMemo(() => StyleSheet.create({
  flex: { flex: 1 },
  line: { paddingVertical: 13, paddingHorizontal: 14 },
  ruled: { borderTopWidth: 1, borderTopColor: COLORS.borderLight },
  lineHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  lineRate: { marginTop: 3 },
  inputs: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, marginTop: 10 },
  remove: { paddingHorizontal: 8, paddingVertical: 13 },
  addWrap: { padding: 14, borderTopWidth: 1, borderTopColor: COLORS.borderLight },
}), [COLORS]);
  const parties = useApi(() => Customers.list({ limit: 200 }), []);
  const items = useApi(() => Items.list({ limit: 200 }), []);

  const [customerId, setCustomerId] = React.useState(null);
  const [lines, setLines] = React.useState([]);
  const [notes, setNotes] = React.useState('');
  const [picking, setPicking] = React.useState(null);

  // 3.3 — the Party Information Card. Fetched the moment a party is chosen,
  // so a blocked credit limit or a 60-day overdue balance is obvious before
  // a whole order is filled in, not only inside the 409 a punch returns.
  const creditStatus = useApi(
    () => (customerId ? Customers.creditStatus(customerId) : Promise.resolve(null)),
    [customerId]
  );

  const party = (parties.data?.customers || []).find((c) => c.masterid === customerId);
  const catalogue = (items.data?.items || []).map((i) => ({
    value: i.masterid,
    label: `${i.name} · ${rupees(i.rate)}`,
  }));

  function addLine(itemId) {
    const master = (items.data?.items || []).find((i) => i.masterid === itemId);
    if (!master) return;
    setLines((prev) => [
      ...prev,
      {
        item_id: master.masterid,
        name: master.name,
        rate: Number(master.rate),
        gst: Number(master.gst_percent) || 0,
        unit: master.unit,
        qty: '1',
        discount: '0',
        scheme: '0',
      },
    ]);
    setPicking(null);
  }

  const setLine = (index, patch) =>
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));

  const rows = lines.map((l) => {
    const qty = Number(l.qty) || 0;
    const discount = Number(l.discount) || 0;
    const net = qty * l.rate * (1 - discount / 100);
    return { ...l, net, gstAmount: net * (l.gst / 100) };
  });

  const subTotal = rows.reduce((sum, r) => sum + r.net, 0);
  const gstTotal = rows.reduce((sum, r) => sum + r.gstAmount, 0);
  const grandTotal = subTotal + gstTotal;

  const info = creditStatus.data;
  const projectedFree = info ? info.free - grandTotal : null;
  const willCrossLimit = info && info.credit_limit > 0 && projectedFree < 0;
  const willBlock = willCrossLimit || info?.overdue_60;

  const ready = customerId && rows.length > 0 && rows.every((r) => Number(r.qty) > 0);

  // 3.3 — CHANGED FROM v1: both are a hard block at punch now, not a
  // notification. `override` is only ever sent when the block already fired
  // once and an owner chose to clear it — never speculatively.
  const punch = (override) =>
    Orders.create({
      customer_id: customerId,
      items: rows.map((r) => ({
        item_id: r.item_id,
        qty: Number(r.qty),
        discount: Number(r.discount) || 0,
        scheme: Number(r.scheme) || 0,
      })),
      notes: notes.trim(),
      ...(override ? { override: true, override_note: 'Overridden at punch by ' + role.name } : {}),
    });

  const create = useAction(() => punch(false), {
    onDone: (result) => {
      showAlert('Order placed', `Sent for approval — ${rupees(result.total_amount)}.`);
      onSaved?.();
    },
    onFail: (message, err) => {
      const code = err?.response?.data?.code;
      const blocked = code === 'CREDIT_LIMIT_EXCEEDED' || code === 'OVERDUE_60_BLOCK';
      if (blocked && role.isOwner) {
        confirmAction(
          'Override and place anyway?',
          `${message}\n\nThis will be logged against your name.`,
          () => override.run()
        );
        return;
      }
      showAlert(blocked ? 'Blocked' : 'Could not place', message);
    },
  });

  const override = useAction(() => punch(true), {
    onDone: (result) => {
      showAlert('Order placed (overridden)', `Sent for approval — ${rupees(result.total_amount)}.`);
      onSaved?.();
    },
    onFail: (message) => showAlert('Could not place', message),
  });

  const noOrder = useAction(
    () => Orders.create({ customer_id: customerId, items: [], is_no_order: true, notes: notes.trim() }),
    {
      onDone: () => {
        showAlert('Visit recorded', 'Logged as a no-order call.');
        onSaved?.();
      },
      onFail: (message) => showAlert('Could not record', message),
    }
  );

  return (
    <Screen
      nav={nav}
      header={
        <ScreenHeader
          clock=""
          role={role.name}
          title="Take Order"
          subtitle={party?.name || 'Pick a party'}
          onBack={onBack}
          backLabel="Today"
          badge="Draft"
          badgeTone="onBrand"
        />
      }
      footer={
        <>
          <ActionButton
            label={ready ? `Send for approval · ${rupees(grandTotal)}` : 'Add a party and items'}
            tone="brand"
            disabled={!ready}
            loading={create.busy || override.busy}
            loadingLabel="Placing"
            onPress={() =>
              confirmAction(
                'Send this order for approval?',
                `${party.name} — ${rupees(grandTotal)}.${
                  willBlock ? ' This will be blocked at punch — the server has the final word.' : ''
                }`,
                create.run
              )
            }
          />
          {customerId && !rows.length ? (
            <ActionButton
              label="No order from this call"
              tone="neutral"
              loading={noOrder.busy}
              onPress={() =>
                confirmAction(
                  'Record a no-order visit?',
                  'The call is logged with no order against it. It still counts on your beat.',
                  noOrder.run
                )
              }
            />
          ) : null}
        </>
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
        <Card title="Party">
          <Select
            value={customerId}
            options={(parties.data?.customers || []).map((c) => ({
              value: c.masterid,
              label: c.name,
            }))}
            onChange={setCustomerId}
            placeholder="Choose the party"
          />
        </Card>

        {/* 3.3 — the Party Information Card, shown before the order is
            saved: credit limit, used, free, last order date, outstanding
            and the age of the oldest bill. */}
        {party && info ? (
          <Card title="Party Information" flush>
            <DetailRow label="Credit limit" value={rupees(info.credit_limit)} />
            <DetailRow label="Used" value={rupees(info.used)} />
            <DetailRow
              label="Free"
              value={rupees(info.free)}
              tone={info.free > 0 ? 'success' : 'danger'}
            />
            <DetailRow label="Outstanding" value={rupees(info.outstanding)} />
            <DetailRow
              label="Oldest bill"
              value={info.oldest_bill_days === null ? 'None outstanding' : `${info.oldest_bill_days} days`}
              tone={info.overdue_60 ? 'danger' : 'muted'}
            />
            <DetailRow
              label="Last order"
              value={info.last_order_date ? formatDate(info.last_order_date) : 'No prior order'}
              last
            />
          </Card>
        ) : null}

        {willCrossLimit ? (
          <NoticeBar tone="danger">
            {`This order is ${rupees(-projectedFree)} over the party's credit limit. `
              + (role.isOwner ? 'You can override this at punch.' : 'Only Yash or Manoj can override this at punch.')}
          </NoticeBar>
        ) : null}
        {info?.overdue_60 ? (
          <NoticeBar tone="danger">
            {`${party?.name || 'This party'} has ${info.outstanding_invoices} invoice(s) more than 60 days overdue. `
              + (role.isOwner ? 'You can override this at punch.' : 'Only Yash or Manoj can override this at punch.')}
          </NoticeBar>
        ) : null}

        <Card title={`Items (${rows.length})`} flush>
          {rows.map((line, index) => (
            <View key={`${line.item_id}-${index}`} style={[styles.line, index ? styles.ruled : null]}>
              <View style={styles.lineHead}>
                <AppText weight="bold" size="sm" style={styles.flex}>{line.name}</AppText>
                <AppText weight="bold" size="sm" color={COLORS.brand}>
                  {rupees(line.net + line.gstAmount)}
                </AppText>
              </View>

              <AppText size="xs" color={COLORS.textMuted} style={styles.lineRate}>
                {`Rate ${rupees(line.rate)}${line.unit ? `/${line.unit}` : ''} · from item master`}
              </AppText>

              <View style={styles.inputs}>
                <Field
                  label="Qty"
                  style={styles.flex}
                  value={line.qty}
                  onChangeText={(v) => setLine(index, { qty: v.replace(/[^0-9.]/g, '') })}
                  keyboardType="decimal-pad"
                />
                <Field
                  label="Disc %"
                  style={styles.flex}
                  value={line.discount}
                  onChangeText={(v) => setLine(index, { discount: v.replace(/[^0-9.]/g, '') })}
                  keyboardType="decimal-pad"
                />
                <Field
                  label="Scheme"
                  style={styles.flex}
                  value={line.scheme}
                  onChangeText={(v) => setLine(index, { scheme: v.replace(/[^0-9.]/g, '') })}
                  keyboardType="decimal-pad"
                  hint={index === 0 ? 'Free goods' : undefined}
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
            <Select value={picking} options={catalogue} onChange={addLine} placeholder="+ Add an item" />
          </View>
        </Card>

        {rows.length ? (
          <Card flush>
            <DetailRow label="Sub total" value={rupees(subTotal, { decimals: 'auto' })} />
            <DetailRow label="GST" value={rupees(gstTotal, { decimals: 'auto' })} tone="muted" />
            <DetailRow label="Grand total" value={rupees(subTotal + gstTotal, { decimals: 'auto' })} tone="brand" last />
          </Card>
        ) : null}

        <Card title="Instructions">
          <Field
            value={notes}
            onChangeText={setNotes}
            placeholder="e.g. 3rd floor, call first"
            multiline
            hint="Shown to the driver at delivery"
          />
        </Card>
      </AsyncBoundary>
    </Screen>
  );
}


