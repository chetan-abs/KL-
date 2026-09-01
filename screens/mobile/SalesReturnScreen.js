import React from 'react';
import { View, StyleSheet } from 'react-native';

import { useThemeColors } from '../../context/ThemeContext';
import { RETURN_REASONS } from '../../constants/options';
import { Billing, Returns } from '../../services/endpoints';
import { useApi, useAction } from '../../hooks/useApi';
import { rupees } from '../../utils/format';
import { captureAndUpload } from '../../utils/capture';
import { confirmAction, showAlert } from '../../services/confirm';
import AppText from '../../components/AppText';
import Screen from '../../components/mobile/Screen';
import ScreenHeader from '../../components/mobile/ScreenHeader';
import Card from '../../components/mobile/Card';
import DetailRow from '../../components/mobile/DetailRow';
import QtyBox from '../../components/mobile/QtyBox';
import Select from '../../components/mobile/Select';
import Badge from '../../components/mobile/Badge';
import PhotoBox from '../../components/mobile/PhotoBox';
import ActionButton from '../../components/mobile/ActionButton';
import NoticeBar from '../../components/mobile/NoticeBar';
import AsyncBoundary from '../../components/mobile/AsyncBoundary';

/**
 * 16 — Sales return against an invoice. Step 1 of 3 (section 6, September
 * 2026): entry only. Whoever receives the goods records what they were
 * told — items, quantity, a reason per line, a photo — and that is all this
 * screen does. Stock does not move and no credit note exists yet: Sonu's
 * physical check (ReturnApprovalScreen) is what moves stock and raises the
 * note, and the entry's own creator is never the one who can approve it —
 * enforced server-side, which is why this screen has no "accept" button any
 * more.
 *
 * Quantities are capped at what was billed: a return of more than went out is
 * always a keying error, and letting it through would credit the party twice
 * and invent stock that never existed. The server enforces the same cap; the
 * rate is read server-side too, from the invoice itself, never typed here.
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
  const [photoRef, setPhotoRef] = React.useState(null);

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

  const capture = useAction(
    async () => {
      const ref = await captureAndUpload({ refType: 'sales_return', refId: invoiceId });
      if (!ref) return null; // cancelled — not a failure
      setPhotoRef(ref);
      return ref;
    },
    { onFail: (message) => showAlert('Could not capture', message) }
  );

  const raise = useAction(
    () =>
      Returns.raise({
        customer_id: detail.data.invoice.customer_id,
        invoice_id: invoiceId,
        photo_id: photoRef,
        reason: reasons[rows.find((r) => r.qty > 0)?.id] || RETURN_REASONS[0].value,
        lines: rows
          .filter((r) => r.qty > 0)
          .map((r) => ({
            item_id: r.item_id,
            return_qty: r.qty,
            reason: reasons[r.id] || RETURN_REASONS[0].value,
          })),
      }),
    {
      onDone: () => {
        showAlert('Return entered', 'Sent to Sonu for a physical check before any credit note is raised.');
        onDone?.();
      },
      onFail: (message) => showAlert('Could not enter', message),
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
            label={nothing ? 'Nothing to return' : `Enter Return · ${rupees(total)}`}
            tone="brand"
            disabled={nothing || overreturn || !photoRef}
            loading={raise.busy}
            loadingLabel="Entering"
            onPress={() =>
              confirmAction(
                'Enter this return?',
                `${rupees(total)} — sent to Sonu for a physical check. Stock does not move until he approves it.`,
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
              <DetailRow label="Entered value" value={rupees(total)} tone="brand" last />
            </Card>

            <Card
              title="Photo (mandatory)"
              right={<Badge tone={photoRef ? 'success' : 'danger'}>{photoRef ? 'Captured' : 'Required'}</Badge>}
            >
              <PhotoBox
                title="Photo of the returned goods"
                captured={Boolean(photoRef)}
                onPress={capture.run}
              />
              {capture.busy ? (
                <NoticeBar tone="info" glyph="📷" style={styles.meta}>Uploading the photo…</NoticeBar>
              ) : null}
            </Card>

            <NoticeBar tone="info" glyph="↩">
              This is step 1 of 3: entry only. Stock does not move and no credit
              note exists until Sonu (or Hirak) physically checks it.
            </NoticeBar>
          </AsyncBoundary>
        ) : null}
      </AsyncBoundary>
    </Screen>
  );
}


