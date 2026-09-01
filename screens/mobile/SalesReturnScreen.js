import React from 'react';
import { View, StyleSheet } from 'react-native';

import { useThemeColors } from '../../context/ThemeContext';
import { RETURN_REASONS } from '../../constants/options';
import { Billing, Returns } from '../../services/endpoints';
import { useApi, useAction } from '../../hooks/useApi';
import { rupees } from '../../utils/format';
import { confirmAction, showAlert } from '../../services/confirm';
import AppText from '../../components/AppText';
import Screen from '../../components/mobile/Screen';
import ScreenHeader from '../../components/mobile/ScreenHeader';
import Card from '../../components/mobile/Card';
import DetailRow from '../../components/mobile/DetailRow';
import QtyBox from '../../components/mobile/QtyBox';
import Select from '../../components/mobile/Select';
import ActionButton from '../../components/mobile/ActionButton';
import NoticeBar from '../../components/mobile/NoticeBar';
import AsyncBoundary from '../../components/mobile/AsyncBoundary';

/**
 * 16 — Sales return against an invoice.
 *
 * Quantities are capped at what was billed: a return of more than went out is
 * always a keying error, and letting it through would credit the party twice and
 * invent stock that never existed. The server enforces the same cap.
 *
 * Accepting writes `return` movements and recomputes the cached quantity in one
 * transaction, then raises a credit note *pending* — taking goods back and
 * agreeing what they are worth are two decisions, and only the first one
 * happened here.
 */
export default function SalesReturnScreen({ role, onBack, onDone, nav}) {
  const COLORS = useThemeColors();
  const styles = React.useMemo(() => StyleSheet.create({
  flex: { flex: 1 },
  line: { paddingVertical: 13, paddingHorizontal: 14 },
  ruled: { borderTopWidth: 1, borderTopColor: COLORS.borderLight },
  head: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  meta: { marginTop: 4 },
  reason: { marginTop: 11 },
}), [COLORS]);
  const invoices = useApi(() => Billing.queue(), []);
  const [invoiceId, setInvoiceId] = React.useState(null);

  const detail = useApi(
    () => (invoiceId ? Billing.get(invoiceId) : Promise.resolve(null)),
    [invoiceId],
    { enabled: Boolean(invoiceId) }
  );

  const [returns, setReturns] = React.useState({});
  const [reasons, setReasons] = React.useState({});

  const options = (invoices.data?.invoices || []).map((i) => ({
    value: i.id,
    label: `${i.invoice_no} · ${i.party_name} · ${rupees(i.grand_total, { decimals: 'auto' })}`,
  }));

  const rows = (detail.data?.lines || []).map((line) => {
    const raw = returns[line.id] ?? '';
    const qty = Number(raw) || 0;
    return { ...line, raw, qty, over: qty > Number(line.qty), value: qty * Number(line.rate) };
  });

  const total = rows.reduce((sum, r) => sum + r.value, 0);
  const overreturn = rows.some((r) => r.over);
  const nothing = total <= 0;

  const raise = useAction(
    async () => {
      const created = await Returns.raise({
        customer_id: detail.data.invoice.customer_id,
        invoice_id: invoiceId,
        lines: rows
          .filter((r) => r.qty > 0)
          .map((r) => ({
            item_id: r.item_id,
            return_qty: r.qty,
            rate: Number(r.rate),
            reason: reasons[r.id] || RETURN_REASONS[0].value,
          })),
      });
      return Returns.accept(created.return_id);
    },
    {
      onDone: (result) => {
        showAlert(
          'Return accepted',
          `Credit note ${result.note_no} raised for ${rupees(result.amount)}. Issue it to reduce their balance.`
        );
        onDone?.();
      },
      onFail: (message) => showAlert('Could not accept', message),
    }
  );

  return (
    <Screen
      nav={nav}
      header={
        <ScreenHeader
          clock=""
          role={role.name}
          title="Sales Return"
          subtitle={detail.data?.invoice?.party_name || 'Pick an invoice'}
          onBack={onBack}
          backLabel="Credit"
          badge="Return"
          badgeTone="pending"
        />
      }
      footer={
        invoiceId ? (
          <ActionButton
            label={nothing ? 'Nothing to return' : `Accept Return · ${rupees(total)}`}
            tone="brand"
            disabled={nothing || overreturn}
            loading={raise.busy}
            loadingLabel="Accepting"
            onPress={() =>
              confirmAction(
                'Accept this return?',
                `${rupees(total)} credited to ${detail.data.invoice.party_name}. Stock re-enters the ledger as an adjustment.`,
                raise.run
              )
            }
          />
        ) : null
      }
    >
      <AsyncBoundary
        loading={invoices.loading}
        error={invoices.error}
        onRetry={invoices.reload}
        empty={!options.length}
        emptyText="No invoices to return against yet."
      >
        <Card title="Against invoice">
          <Select
            value={invoiceId}
            options={options}
            onChange={(value) => {
              setInvoiceId(value);
              setReturns({});
            }}
            placeholder="Choose the invoice"
          />
        </Card>

        {invoiceId ? (
          <AsyncBoundary loading={detail.loading} error={detail.error} onRetry={detail.reload}>
            <Card flush>
              <DetailRow label="Party" value={detail.data?.invoice?.party_name} tone="brand" />
              <DetailRow label="Invoice" value={detail.data?.invoice?.invoice_no} />
              <DetailRow label="Billed" value={rupees(detail.data?.invoice?.grand_total, { decimals: 'auto' })} last />
            </Card>

            <Card title="Lines" flush>
              {rows.map((row, index) => (
                <View key={row.id} style={[styles.line, index ? styles.ruled : null]}>
                  <View style={styles.head}>
                    <View style={styles.flex}>
                      <AppText weight="bold" size="sm">{row.item_name}</AppText>
                      <AppText size="xs" color={COLORS.textSecondary} style={styles.meta}>
                        {`Billed ${Number(row.qty)} × ${rupees(row.rate)}`}
                      </AppText>
                    </View>
                    <QtyBox
                      label="Return"
                      value={row.raw}
                      onChangeText={(v) =>
                        setReturns((prev) => ({ ...prev, [row.id]: v.replace(/[^0-9]/g, '') }))
                      }
                      target={Number(row.qty)}
                      tone={row.over ? 'danger' : row.qty > 0 ? 'warning' : 'neutral'}
                    />
                  </View>

                  {row.qty > 0 ? (
                    <Select
                      style={styles.reason}
                      value={reasons[row.id] || RETURN_REASONS[0].value}
                      options={RETURN_REASONS}
                      onChange={(value) => setReasons((prev) => ({ ...prev, [row.id]: value }))}
                    />
                  ) : null}

                  {row.over ? (
                    <AppText size="xs" color={COLORS.error} style={styles.meta}>
                      {`Cannot return more than the ${Number(row.qty)} billed.`}
                    </AppText>
                  ) : null}
                </View>
              ))}
            </Card>

            <Card flush>
              <DetailRow label="Credit value" value={rupees(total)} tone="brand" last />
            </Card>

            <NoticeBar tone="info" glyph="↩">
              Returned stock re-enters the ledger as an adjustment. The original movement is never edited.
            </NoticeBar>
          </AsyncBoundary>
        ) : null}
      </AsyncBoundary>
    </Screen>
  );
}


