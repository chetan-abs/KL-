import React from 'react';
import { View, StyleSheet } from 'react-native';

import { COLORS } from '../../constants/colors';
import { Orders, Verification } from '../../services/endpoints';
import { useApi, useAction } from '../../hooks/useApi';
import { confirmAction, showAlert } from '../../services/confirm';
import AppText from '../../components/AppText';
import Screen from '../../components/mobile/Screen';
import ScreenHeader from '../../components/mobile/ScreenHeader';
import Card from '../../components/mobile/Card';
import QtyBox from '../../components/mobile/QtyBox';
import CircleButton from '../../components/mobile/CircleButton';
import ActionButton from '../../components/mobile/ActionButton';
import NoticeBar from '../../components/mobile/NoticeBar';
import AsyncBoundary from '../../components/mobile/AsyncBoundary';

/**
 * 08 — Ajit's physical count. Mandatory before an invoice can be raised (R02);
 * a mismatch alerts Yash.
 *
 * The count is entered against what the SO says, not shown as a difference to
 * confirm — "SO says 10" sits under the item and the counted figure is typed
 * fresh. Presenting the expected number *in* the box invites confirming it, and
 * the boxes therefore start empty rather than pre-filled.
 *
 * The mismatch strip appears as soon as the numbers disagree rather than on
 * submit, because the correction Ajit can still make — recount, or find the
 * missing two — is only cheap while the goods are in front of him.
 */
export default function VerifyScreen({ role, orderId, party, onBack, onVerified, nav}) {
  const { data, loading, error, reload } = useApi(() => Orders.get(orderId), [orderId]);
  const [counts, setCounts] = React.useState({});

  const lines = data?.order?.items || [];

  const rows = lines.map((line) => {
    const counted = counts[line.id] ?? '';
    const number = Number(counted);
    const blank = counted === '';
    const matches = !blank && Number.isFinite(number) && number === Number(line.qty);
    return { ...line, counted, blank, matches };
  });

  const mismatches = rows.filter((r) => !r.blank && !r.matches);
  const incomplete = rows.some((r) => r.blank);

  const submit = useAction(
    () =>
      Verification.submit(
        orderId,
        rows.map((r) => ({ order_item_id: r.id, counted_qty: Number(r.counted) }))
      ),
    {
      onDone: (result) => {
        showAlert(
          'Verified',
          result?.mismatches
            ? `Verified with ${result.mismatches} mismatch. Yash has been alerted.`
            : 'Verified and sent to Gaurav for billing.'
        );
        onVerified?.();
      },
      onFail: (message) => showAlert('Could not verify', message),
    }
  );

  function confirmVerify() {
    if (mismatches.length) {
      confirmAction(
        'Sign off with a mismatch?',
        `${mismatches.length} line does not match the SO. Yash is alerted automatically and the invoice will bill the counted quantity.`,
        submit.run
      );
      return;
    }
    submit.run();
  }

  return (
    <Screen
      nav={nav}
      header={
        <ScreenHeader
          clock={`#${orderId}`}
          role={role.name}
          title={`Verify #${orderId}`}
          subtitle={party}
          onBack={onBack}
          backLabel="Verify"
          badge="Verify"
          badgeTone="pending"
        />
      }
      footer={
        rows.length ? (
          <ActionButton
            label="Sign + Mark Verified  ✓"
            tone={mismatches.length ? 'brand' : 'approve'}
            disabled={incomplete}
            loading={submit.busy}
            loadingLabel="Signing"
            onPress={confirmVerify}
          />
        ) : null
      }
    >
      <AsyncBoundary
        loading={loading}
        error={error}
        onRetry={reload}
        empty={!rows.length}
        emptyText="This order has no lines to count."
      >
        <Card title="Physical count" flush>
          {rows.map((row, index) => (
            <View key={row.id} style={[styles.row, index ? styles.ruled : null]}>
              <View style={styles.body}>
                <AppText weight="bold" size="sm">{row.item_name}</AppText>
                <AppText size="xs" color={COLORS.textSecondary} style={styles.meta}>
                  {`SO says: ${Number(row.qty)}`}
                </AppText>
              </View>

              <QtyBox
                label="Counted"
                value={row.counted}
                onChangeText={(next) =>
                  setCounts((prev) => ({ ...prev, [row.id]: next.replace(/[^0-9]/g, '') }))
                }
                tone={row.blank ? 'neutral' : row.matches ? 'success' : 'danger'}
              />

              <CircleButton
                glyph={row.matches ? '✓' : '✗'}
                tone={row.matches ? 'success' : 'danger'}
                filled={!row.blank}
                accessibilityLabel={
                  row.blank
                    ? `${row.item_name}: not counted`
                    : row.matches
                      ? `${row.item_name}: matches`
                      : `${row.item_name}: mismatch`
                }
              />
            </View>
          ))}
        </Card>

        {mismatches.map((row) => (
          <NoticeBar key={row.id} tone="danger">
            {`Mismatch: ${row.item_name} — SO says ${Number(row.qty)}, counted ${row.counted}. Yash alerted automatically.`}
          </NoticeBar>
        ))}

        {incomplete ? (
          <NoticeBar tone="warning">
            Count every line before signing. A blank line is not a zero.
          </NoticeBar>
        ) : null}
      </AsyncBoundary>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 13, paddingHorizontal: 14, gap: 11 },
  ruled: { borderTopWidth: 1, borderTopColor: COLORS.borderLight },
  body: { flex: 1 },
  meta: { marginTop: 3 },
});
