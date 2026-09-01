import React from 'react';
import { View, RefreshControl, StyleSheet } from 'react-native';

import { useThemeColors } from '../../context/ThemeContext';
import { Payroll } from '../../services/endpoints';
import { useApi, useAction } from '../../hooks/useApi';
import { rupees } from '../../utils/format';
import { formatDate, todayString } from '../../utils/datetime';
import { confirmAction, showAlert } from '../../services/confirm';
import AppText from '../../components/AppText';
import Screen from '../../components/mobile/Screen';
import ScreenHeader from '../../components/mobile/ScreenHeader';
import Card from '../../components/mobile/Card';
import Badge from '../../components/mobile/Badge';
import Field from '../../components/mobile/Field';
import NoticeBar from '../../components/mobile/NoticeBar';
import ProgressBar from '../../components/mobile/ProgressBar';
import ActionButton from '../../components/mobile/ActionButton';
import AsyncBoundary from '../../components/mobile/AsyncBoundary';

/**
 * Advances and leave — addendum B and C.6.
 *
 * Two subjects on one screen because they are the same shape from the
 * employee's side: ask for something, wait for Yash or Manas. Splitting them
 * would give the twenty people who use this two tabs that are each half empty.
 *
 * R-27 and the leave rule are both enforced server-side — nobody approves their
 * own — so the approve control is simply not drawn on your own request rather
 * than being drawn and refused.
 */

const STATUS_TONE = {
  pending: 'pending',
  approved: 'success',
  rejected: 'danger',
  closed: 'neutral',
  cancelled: 'neutral',
};

export default function AdvancesScreen({ role, nav, onBack }) {
  const COLORS = useThemeColors();
  const styles = React.useMemo(() => StyleSheet.create({
  tabs: { flexDirection: 'row', gap: 10 },
  half: { flex: 1 },
  row: { flexDirection: 'row', paddingVertical: 12, paddingHorizontal: 14, gap: 10 },
  ruled: { borderTopWidth: 1, borderTopColor: COLORS.borderLight },
  body: { flex: 1 },
  meta: { marginTop: 3 },
  progress: { marginTop: 8, gap: 4 },
  decide: { flexDirection: 'row', gap: 8, marginTop: 10 },
}), [COLORS]);
  const [tab, setTab] = React.useState('advances');

  const advances = useApi(() => Payroll.advances(), []);
  const leave = useApi(() => Payroll.leave(), []);

  // ---- advance request ---------------------------------------------------
  const [amount, setAmount] = React.useState('');
  const [months, setMonths] = React.useState('3');
  const [reason, setReason] = React.useState('');

  const request = useAction(
    () => Payroll.requestAdvance({
      amount: Number(amount),
      months: Number(months),
      reason: reason.trim() || null,
    }),
    {
      onDone: (r) => {
        setAmount(''); setReason('');
        advances.reload();
        showAlert('Requested',
          `${rupees(r.monthly_amount)} a month for ${months} month(s), once approved.`);
      },
    }
  );

  // ---- leave -------------------------------------------------------------
  const [fromDate, setFromDate] = React.useState(todayString());
  const [toDate, setToDate] = React.useState(todayString());
  const [leaveReason, setLeaveReason] = React.useState('');

  const applyLeave = useAction(
    () => Payroll.applyLeave({
      from_date: fromDate, to_date: toDate, reason: leaveReason.trim() || null,
    }),
    { onDone: () => { setLeaveReason(''); leave.reload(); } }
  );

  const decideAdvance = useAction(
    ({ id, approve }) => Payroll.decideAdvance(id, approve),
    { onDone: advances.reload }
  );
  const decideLeave = useAction(
    ({ id, approve }) => Payroll.decideLeave(id, approve),
    { onDone: leave.reload }
  );

  const showing = tab === 'advances';
  const source = showing ? advances : leave;
  const rows = showing ? (advances.data?.advances || []) : (leave.data?.leave || []);

  // The instalment, shown before the request is made. B.1's own example:
  // "Advance of 6,000 over 3 months → 2,000 deducted each month."
  const monthly = Number(amount) > 0 && Number(months) > 0
    ? Number(amount) / Number(months) : 0;

  return (
    <Screen
      header={
        <ScreenHeader
          clock=""
          role={role.name}
          title={showing ? 'Advances' : 'Leave'}
          subtitle={`${rows.length} on record`}
          badge={String(rows.filter((r) => r.status === 'pending').length)}
          badgeTone={rows.some((r) => r.status === 'pending') ? 'pending' : 'neutral'}
          onBack={onBack}
        />
      }
      nav={nav}
      refreshControl={
        <RefreshControl
          refreshing={source.refreshing}
          onRefresh={source.refresh}
          tintColor={COLORS.brand}
        />
      }
    >
      <View style={styles.tabs}>
        <ActionButton
          tone={showing ? 'brand' : 'neutral'}
          size="sm"
          label="Advances"
          onPress={() => setTab('advances')}
          style={styles.half}
        />
        <ActionButton
          tone={!showing ? 'brand' : 'neutral'}
          size="sm"
          label="Leave"
          onPress={() => setTab('leave')}
          style={styles.half}
        />
      </View>

      {/* An owner draws no salary, so there is nothing for a recovery
          instalment to come off, and no leave of their own to apply for. The
          request forms are for staff; an owner's version of this screen is
          the register and the approve buttons below, nothing above them. */}
      {role.isOwner ? (
        <NoticeBar tone="info">
          {showing
            ? "An owner's view — every advance on record, and the approve/decline that only Yash or Manoj can give."
            : "An owner's view — every leave request on record, and the decision."}
        </NoticeBar>
      ) : showing ? (
        <Card title="Request an advance">
          <Field
            label="Amount"
            value={amount}
            onChangeText={setAmount}
            keyboardType="numeric"
            placeholder="6000"
            required
          />
          <Field
            label="Repay over (months)"
            value={months}
            onChangeText={setMonths}
            keyboardType="numeric"
            required
          />
          <Field
            label="Reason"
            value={reason}
            onChangeText={setReason}
            placeholder="Optional"
          />
          {monthly > 0 ? (
            <NoticeBar tone="info">
              {`${rupees(monthly)} would come off each month's salary, starting the `
                + 'month after approval.'}
            </NoticeBar>
          ) : null}
          <ActionButton
            label={request.busy ? 'Sending…' : 'Request'}
            onPress={request.run}
            disabled={request.busy || !(Number(amount) > 0)}
          />
          {request.error ? (
            <NoticeBar tone="danger">{request.error}</NoticeBar>
          ) : null}
        </Card>
      ) : (
        <Card title="Apply for leave">
          <Field label="From" value={fromDate} onChangeText={setFromDate} placeholder="YYYY-MM-DD" required />
          <Field label="To" value={toDate} onChangeText={setToDate} placeholder="YYYY-MM-DD" required />
          <Field label="Reason" value={leaveReason} onChangeText={setLeaveReason} placeholder="Optional" />
          <NoticeBar tone="info">
            Approved leave is not counted as absent without information, which is
            the difference between one day's deduction and two.
          </NoticeBar>
          <ActionButton
            label={applyLeave.busy ? 'Sending…' : 'Apply'}
            onPress={applyLeave.run}
            disabled={applyLeave.busy}
          />
          {applyLeave.error ? <NoticeBar tone="danger">{applyLeave.error}</NoticeBar> : null}
        </Card>
      )}

      <AsyncBoundary
        loading={source.loading}
        error={source.error}
        onRetry={source.reload}
        empty={!rows.length}
        emptyGlyph={showing ? '₹' : '☂'}
        emptyText={showing ? 'No advances on record.' : 'No leave on record.'}
      >
        <Card title={showing ? 'Advance ledger' : 'Leave'} flush>
          {rows.map((row, index) => {
            const mine = row.employee_id === role.key;
            const pending = row.status === 'pending';

            return (
              <View key={row.id} style={[styles.row, index ? styles.ruled : null]}>
                <View style={styles.body}>
                  <AppText weight="bold" size="sm">
                    {showing
                      ? `${rupees(row.amount)} over ${row.months} month(s)`
                      : `${formatDate(row.from_date)}${
                        String(row.to_date) !== String(row.from_date)
                          ? ` – ${formatDate(row.to_date)}` : ''}`}
                  </AppText>
                  <AppText size="xs" color={COLORS.textMuted} style={styles.meta}>
                    {[row.employee_name, row.reason].filter(Boolean).join(' · ')}
                  </AppText>

                  {showing && row.status === 'approved' ? (
                    <View style={styles.progress}>
                      <ProgressBar
                        value={Number(row.recovered)}
                        total={Number(row.amount) || 1}
                        tone={COLORS.success}
                      />
                      <AppText size="xs" color={COLORS.textMuted} style={styles.meta}>
                        {`${rupees(row.recovered)} recovered · ${rupees(row.balance)} to go `
                          + `· ${row.months_remaining} month(s)`}
                      </AppText>
                    </View>
                  ) : null}

                  {/* R-27: nobody approves their own. Not drawn rather than
                      drawn and refused. */}
                  {pending && !mine && (showing ? role.managesSalary : role.approvesLeave) ? (
                    <View style={styles.decide}>
                      <ActionButton
                        tone="approve"
                        size="sm"
                        label="Approve"
                        onPress={() => confirmAction(
                          showing ? 'Approve this advance?' : 'Approve this leave?',
                          showing
                            ? `${rupees(row.amount)}, recovered at ${rupees(row.monthly_amount)} a month.`
                            : `${formatDate(row.from_date)} to ${formatDate(row.to_date)}.`,
                          () => (showing ? decideAdvance : decideLeave)
                            .run({ id: row.id, approve: true })
                        )}
                      />
                      <ActionButton
                        tone="reject"
                        size="sm"
                        label="Decline"
                        onPress={() => (showing ? decideAdvance : decideLeave)
                          .run({ id: row.id, approve: false })}
                      />
                    </View>
                  ) : null}
                </View>

                <Badge tone={STATUS_TONE[row.status] || 'neutral'}>
                  {String(row.status).toUpperCase()}
                </Badge>
              </View>
            );
          })}
        </Card>
      </AsyncBoundary>
    </Screen>
  );
}

