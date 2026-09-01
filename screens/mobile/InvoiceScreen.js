import React from 'react';
import { View, StyleSheet } from 'react-native';

import { useThemeColors } from '../../context/ThemeContext';
import { Orders, Billing } from '../../services/endpoints';
import { useApi, useAction } from '../../hooks/useApi';
import { rupees } from '../../utils/format';
import { confirmAction, showAlert } from '../../services/confirm';
import AppText from '../../components/AppText';
import Screen from '../../components/mobile/Screen';
import ScreenHeader from '../../components/mobile/ScreenHeader';
import Card from '../../components/mobile/Card';
import DetailRow from '../../components/mobile/DetailRow';
import Field from '../../components/mobile/Field';
import ActionButton from '../../components/mobile/ActionButton';
import NoticeBar from '../../components/mobile/NoticeBar';
import AsyncBoundary from '../../components/mobile/AsyncBoundary';

/**
 * 09 — Gaurav bills. Only after Ajit verifies; the rate is Gaurav's alone to
 * edit (R04).
 *
 * The quantity shown is what was *counted*, not what was ordered — a short pick
 * bills short, which is the whole reason the count happens first. Quantity is
 * not editable here for the same reason: it is evidence, not an opinion.
 *
 * Below-cost is flagged by the server on the saved line and confirmed here
 * before submitting. It is a warning, not a block: a distress sale and a
 * correction against a credit note are both legitimate, and Gaurav is the person
 * trusted with the call. It simply cannot happen quietly.
 */
export default function InvoiceScreen({ role, orderId, party, onBack, onInvoiced, nav}) {
  const COLORS = useThemeColors();
  const styles = React.useMemo(() => StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 13, paddingHorizontal: 14, gap: 8 },
  ruled: { borderTopWidth: 1, borderTopColor: COLORS.borderLight },
  body: { flex: 1 },
  meta: { marginTop: 3 },
  rateField: { width: 82 },
  rateInput: { minHeight: 40, textAlign: 'right', paddingHorizontal: 9 },
  unit: { width: 12 },
}), [COLORS]);
  const { data, loading, error, reload } = useApi(() => Orders.get(orderId), [orderId]);
  const [rates, setRates] = React.useState({});
  // Billing, September 2026 — "round-off, capped at ₹10 per invoice." The
  // server clamps it regardless; the cap is repeated here only so Gaurav
  // sees the limit before he tries to exceed it.
  const [roundOff, setRoundOff] = React.useState('0');

  const order = data?.order;
  const lines = order?.items || [];

  React.useEffect(() => {
    if (!lines.length) return;
    setRates(Object.fromEntries(lines.map((l) => [l.id, String(Number(l.rate))])));
  }, [data]);

  const rows = lines.map((line) => {
    const rate = Number(rates[line.id] ?? line.rate) || 0;
    const qty = Number(line.qty);
    const discount = Number(line.discount) || 0;
    const net = qty * rate * (1 - discount / 100);
    return { ...line, rate, qty, net, gst: net * (Number(line.gst_percent) || 0) / 100 };
  });

  const subTotal = rows.reduce((sum, r) => sum + r.net, 0);
  const gstTotal = rows.reduce((sum, r) => sum + r.gst, 0);

  const raise = useAction(
    () => Billing.raise(orderId, rows.map((r) => ({ order_item_id: r.id, rate: r.rate })), Number(roundOff) || 0),
    {
      onDone: (result) => {
        showAlert(
          'Invoice created',
          `${result.invoice_no} — ${rupees(result.grand_total, { decimals: true })}.${
            result.below_cost_lines ? ' Below-cost lines were recorded against your name.' : ''
          }${
            // Billing, September 2026 — "reviewed daily", not a block: the
            // invoice above is already issued, this is only Gaurav being
            // told Sibu will be looking at it.
            result.flagged_reason ? `\n\nFlagged for Sibu's review: ${result.flagged_reason}` : ''
          }`
        );
        onInvoiced?.();
      },
      onFail: (message) => showAlert('Could not bill', message),
    }
  );

  function confirmRaise() {
    confirmAction(
      'Create this invoice?',
      `${order.customer_name} — ${rupees(subTotal + gstTotal + (Number(roundOff) || 0), { decimals: true })}. The party's balance moves by this amount.`,
      raise.run
    );
  }

  const notVerified = order && order.status !== 'verified';

  return (
    <Screen
      nav={nav}
      header={
        <ScreenHeader
          clock={`#${orderId}`}
          role={role.name}
          title={`Invoice #${orderId}`}
          subtitle={order ? `${order.status} · ready to bill` : party}
          onBack={onBack}
          backLabel="Billing"
          badge={order?.status === 'verified' ? 'Verified' : order?.status}
          badgeTone={order?.status === 'verified' ? 'success' : 'pending'}
        />
      }
      footer={
        order && !notVerified ? (
          <ActionButton
            label="Create Invoice  →"
            tone="brand"
            loading={raise.busy}
            loadingLabel="Billing"
            onPress={confirmRaise}
          />
        ) : null
      }
    >
      <AsyncBoundary loading={loading} error={error} onRetry={reload}>
        {order ? (
          <>
            {notVerified ? (
              <NoticeBar tone="danger">
                {`This order is ${order.status}. It must be verified by Ajit before it can be billed (R02).`}
              </NoticeBar>
            ) : null}

            <Card flush>
              <DetailRow label="Party" value={order.customer_name} tone="brand" />
              <DetailRow label="SO Narration" value={`#${order.order_id} (auto)`} />
              <DetailRow label="Type" value={order.customer_group || 'Dealer'} last />
            </Card>

            <Card title="Items + rates (Gaurav edits)" flush>
              {rows.map((line, index) => (
                <View key={line.id} style={[styles.row, index ? styles.ruled : null]}>
                  <View style={styles.body}>
                    <AppText weight="bold" size="sm">{line.item_name}</AppText>
                    <AppText size="xs" color={COLORS.textMuted} style={styles.meta}>
                      {`Counted ${line.qty}${line.discount ? ` · ${line.discount}% off` : ''}`}
                    </AppText>
                    <AppText size="xs" color={COLORS.textSecondary} style={styles.meta}>
                      {rupees(line.net + line.gst, { decimals: 'auto' })}
                    </AppText>
                  </View>

                  <Field
                    value={rates[line.id] ?? ''}
                    onChangeText={(next) =>
                      setRates((prev) => ({ ...prev, [line.id]: next.replace(/[^0-9.]/g, '') }))
                    }
                    keyboardType="decimal-pad"
                    style={styles.rateField}
                    inputStyle={styles.rateInput}
                  />
                  <AppText size="xs" color={COLORS.textSecondary} style={styles.unit}>₹</AppText>
                </View>
              ))}
            </Card>

            <Card>
              <Field
                label="Round-off (± ₹10 max)"
                value={roundOff}
                onChangeText={(v) => setRoundOff(v.replace(/[^0-9.-]/g, ''))}
                keyboardType="numbers-and-punctuation"
              />
            </Card>

            <Card flush>
              <DetailRow label="Sub Total" value={rupees(subTotal, { decimals: true })} />
              <DetailRow label="GST" value={rupees(gstTotal, { decimals: true })} tone="muted" />
              {Number(roundOff) ? (
                <DetailRow label="Round-off" value={rupees(Number(roundOff), { decimals: true })} tone="muted" />
              ) : null}
              <DetailRow
                label="Grand Total"
                value={rupees(subTotal + gstTotal + (Number(roundOff) || 0), { decimals: true })}
                tone="brand"
                last
              />
            </Card>
          </>
        ) : null}
      </AsyncBoundary>
    </Screen>
  );
}


