import React from 'react';
import { View, RefreshControl, StyleSheet } from 'react-native';

import { useThemeColors } from '../../context/ThemeContext';
import { Cash } from '../../services/endpoints';
import { useApi, useAction } from '../../hooks/useApi';
import { rupees } from '../../utils/format';
import { confirmAction, showAlert } from '../../services/confirm';
import AppText from '../../components/AppText';
import Screen from '../../components/mobile/Screen';
import ScreenHeader from '../../components/mobile/ScreenHeader';
import Card from '../../components/mobile/Card';
import DetailRow from '../../components/mobile/DetailRow';
import Field from '../../components/mobile/Field';
import StatRow from '../../components/mobile/StatRow';
import ActionButton from '../../components/mobile/ActionButton';
import NoticeBar from '../../components/mobile/NoticeBar';
import AsyncBoundary from '../../components/mobile/AsyncBoundary';

/**
 * 25 — Sibu closes the day.
 *
 * Expected cash is computed and the counted figure is typed beside it, never
 * pre-filled. A pre-filled count is not a count, and catching the day where the
 * drawer and the ledger disagree is the entire purpose of the screen.
 *
 * A variance does not block the close — the money is already whatever it is —
 * but it must be acknowledged explicitly, and the amount is carried into the
 * confirmation so nobody closes a short drawer without reading the number.
 */
export default function EodScreen({ role, nav, onOpenHandover }) {
  const COLORS = useThemeColors();
  const styles = React.useMemo(() => StyleSheet.create({
  flex: { flex: 1 },
  spaced: { marginTop: 13 },
  expected: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 14,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: COLORS.borderLight,
  },
  variance: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 13,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: COLORS.borderLight,
  },
}), [COLORS]);
  const { data, loading, error, refreshing, reload, refresh } = useApi(() => Cash.eod(), []);

  const [opening, setOpening] = React.useState('0');
  const [cashIn, setCashIn] = React.useState('');
  const [expenses, setExpenses] = React.useState('0');
  const [counted, setCounted] = React.useState('');

  const closed = data?.closed;

  const openingNum = Number(opening) || 0;
  const cashNum = Number(cashIn) || 0;
  const spentNum = Number(expenses) || 0;
  const expected = openingNum + cashNum - spentNum;

  const countedNum = Number(counted);
  const entered = counted !== '' && Number.isFinite(countedNum);
  const variance = entered ? countedNum - expected : 0;
  const short = variance < 0;

  const close = useAction(
    () =>
      Cash.closeDay({
        opening_cash: openingNum,
        cash_in: cashNum,
        cheques_in: Number(data?.cheques_in) || 0,
        upi_in: 0,
        expenses: spentNum,
        counted_cash: countedNum,
      }),
    {
      onDone: (result) => {
        showAlert(
          'Day closed',
          Number(result.variance) === 0
            ? `Drawer matched at ${rupees(result.counted_cash)}.`
            : `Closed with a ${Number(result.variance) < 0 ? 'short' : 'over'} of ${rupees(Math.abs(result.variance))}.`
        );
        reload();
      },
      onFail: (message) => showAlert('Could not close', message),
    }
  );

  function confirmClose() {
    confirmAction(
      variance === 0 ? 'Close the day?' : 'Close with a variance?',
      variance === 0
        ? `Drawer matches at ${rupees(expected)}.`
        : `Drawer is ${short ? 'short' : 'over'} by ${rupees(Math.abs(variance))}. This is recorded against your name.`,
      close.run
    );
  }

  return (
    <Screen
      header={
        <ScreenHeader
          clock=""
          role={role.name}
          title="End of Day"
          subtitle={data?.date || (loading ? 'Loading…' : '')}
          badge={closed ? 'Closed' : 'Open'}
          badgeTone={closed ? 'success' : 'pending'}
        />
      }
      nav={nav}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={COLORS.brand} />
      }
      footer={
        closed ? null : (
          <ActionButton
            label={entered ? 'Close the day' : 'Count the cash to close'}
            tone={entered && variance === 0 ? 'approve' : 'brand'}
            disabled={!entered}
            loading={close.busy}
            loadingLabel="Closing"
            onPress={confirmClose}
          />
        )
      }
    >
      <AsyncBoundary loading={loading} error={error} onRetry={reload}>
        <StatRow
          stats={[
            { label: 'Invoiced', value: Number(data?.invoices || 0), tone: 'info' },
            { label: 'Delivered', value: Number(data?.delivered || 0), tone: 'success' },
            { label: 'Failed', value: Number(data?.failed || 0), tone: 'danger' },
          ]}
        />

        {closed ? (
          <>
            <NoticeBar tone="success">
              {`This day is already closed. Counted ${rupees(closed.counted_cash)}, variance ${rupees(closed.variance)}.`}
            </NoticeBar>
            <Card title="Closing" flush>
              <DetailRow label="Expected" value={rupees(closed.expected_cash)} />
              <DetailRow label="Counted" value={rupees(closed.counted_cash)} tone="brand" />
              <DetailRow
                label="Variance"
                value={rupees(closed.variance)}
                tone={Number(closed.variance) === 0 ? 'success' : 'danger'}
                last
              />
            </Card>
          </>
        ) : (
          <>
            <Card title="Collections" flush>
              <DetailRow label="Billed today" value={rupees(data?.billed || 0)} />
              <DetailRow label="Cheques in" value={rupees(data?.cheques_in || 0)} last />
            </Card>

            <Card title="Cash drawer">
              <Field
                label="Opening cash"
                value={opening}
                onChangeText={(v) => setOpening(v.replace(/[^0-9.]/g, ''))}
                keyboardType="decimal-pad"
              />
              <Field
                label="Cash collected"
                style={styles.spaced}
                value={cashIn}
                onChangeText={(v) => setCashIn(v.replace(/[^0-9.]/g, ''))}
                keyboardType="decimal-pad"
                placeholder="0"
              />
              <Field
                label="Expenses paid out"
                style={styles.spaced}
                value={expenses}
                onChangeText={(v) => setExpenses(v.replace(/[^0-9.]/g, ''))}
                keyboardType="decimal-pad"
              />
              <View style={styles.expected}>
                <AppText size="sm" color={COLORS.textSecondary} style={styles.flex}>
                  Expected in drawer
                </AppText>
                <AppText weight="bold" size="md" color={COLORS.brand}>
                  {rupees(expected)}
                </AppText>
              </View>
            </Card>

            <Card title="Physical count">
              <Field
                label="Counted cash"
                required
                value={counted}
                onChangeText={(v) => setCounted(v.replace(/[^0-9.]/g, ''))}
                keyboardType="decimal-pad"
                placeholder="What is actually in the drawer"
                hint="Count first, then type. Do not read the expected figure across."
              />

              {entered ? (
                <View style={styles.variance}>
                  <AppText size="sm" color={COLORS.textSecondary} style={styles.flex}>
                    Variance
                  </AppText>
                  <AppText
                    weight="bold"
                    size="md"
                    color={variance === 0 ? COLORS.success : short ? COLORS.error : COLORS.warning}
                  >
                    {variance === 0
                      ? 'Matches ✓'
                      : `${short ? 'Short' : 'Over'} ${rupees(Math.abs(variance))}`}
                  </AppText>
                </View>
              ) : null}
            </Card>

            {entered && variance !== 0 ? (
              <NoticeBar tone={short ? 'danger' : 'warning'}>
                {`Drawer is ${short ? 'short' : 'over'} by ${rupees(Math.abs(variance))}. Recount before closing — the close is recorded against your name.`}
              </NoticeBar>
            ) : (
              <NoticeBar tone="warning">
                Counted cash must match the drawer before the day can be closed.
              </NoticeBar>
            )}
          </>
        )}

        {/* The collections come in before the drawer is counted, so the
            handover belongs on the way to the close rather than after it. */}
        {onOpenHandover ? (
          <ActionButton
            tone="neutral"
            label="Collections handed in today"
            onPress={onOpenHandover}
          />
        ) : null}
      </AsyncBoundary>
    </Screen>
  );
}

