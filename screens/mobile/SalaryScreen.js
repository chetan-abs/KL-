import React from 'react';
import { View, RefreshControl, StyleSheet, Linking } from 'react-native';

import { COLORS } from '../../constants/colors';
import { Payroll } from '../../services/endpoints';
import { useApi, useAction } from '../../hooks/useApi';
import { rupees } from '../../utils/format';
import { formatDate } from '../../utils/datetime';
import { promptText, showAlert } from '../../services/confirm';
import AppText from '../../components/AppText';
import Screen from '../../components/mobile/Screen';
import ScreenHeader from '../../components/mobile/ScreenHeader';
import Card from '../../components/mobile/Card';
import NoticeBar from '../../components/mobile/NoticeBar';
import ActionButton from '../../components/mobile/ActionButton';
import AsyncBoundary from '../../components/mobile/AsyncBoundary';

/**
 * Salary — addendum A.
 *
 * One employee-month. A DRAFT recomputes from attendance on every read, which
 * is why the month still running shows a moving figure and says so; finalising
 * freezes it and writes the deduction lines so each can be waived individually.
 *
 * The deductions are the point of the screen, not the total. Somebody opening
 * this is nearly always asking "why is it less than the fixed salary", so every
 * line is shown with its date and its reason, and a waived one stays visible at
 * its original amount — it was earned and then forgiven, and hiding it would
 * make the arithmetic look wrong.
 */

const KIND_LABELS = {
  late: 'Late arrival',
  half_day: 'Half day',
  absent_informed: 'Absent — leave approved',
  absent_uninformed: 'Absent without information',
  advance: 'Advance recovery',
  other: 'Other',
};

const STATUS_TONE = {
  draft: 'neutral',
  finalised: 'pending',
  approved: 'success',
  paid: 'success',
};

/** This month, as YYYY-MM. */
const thisMonth = () => new Date().toISOString().slice(0, 7);

export default function SalaryScreen({ role, nav, onBack, params = {} }) {
  const employeeId = params.employeeId || role.key;
  const [period, setPeriod] = React.useState(params.period || thisMonth());

  const { data, loading, error, refreshing, reload, refresh } = useApi(
    () => Payroll.salary(employeeId, period),
    [employeeId, period]
  );

  const row = data?.period || {};
  const lines = data?.lines || [];
  const frozen = data?.frozen;
  const mine = employeeId === role.key;

  // A draft shows the figures the API just derived; a frozen month shows the
  // totals it stored, with waivers already applied.
  const net = frozen ? data?.net_payable : row.net_payable;
  const attendance = frozen ? data?.attendance_deduction : row.attendance_deduction;
  const advance = frozen ? data?.advance_deduction : row.advance_deduction;

  const finalise = useAction(() => Payroll.finalise(employeeId, period), { onDone: reload });
  const approve = useAction(() => Payroll.approveSalary(row.id), { onDone: reload });
  const pay = useAction(() => Payroll.paySalary(row.id), { onDone: reload });
  const share = useAction(() => Payroll.shareSlip(row.id), {
    onDone: () => showAlert('Sent', 'The slip is on the employee\'s alerts.'),
  });

  const waive = useAction(
    ({ id, reason }) => Payroll.waive(id, reason),
    { onDone: reload }
  );

  /**
   * R-28: "Yash may manually waive any deduction with a reason. The waiver is
   * logged."
   *
   * The reason is typed rather than picked from a list. The route refuses an
   * empty one, and a canned reason would satisfy the letter of the rule while
   * recording nothing anybody could act on a year later.
   */
  const askWaive = (line) => {
    promptText({
      title: 'Waive this deduction?',
      message: `${KIND_LABELS[line.kind] || line.kind} — ${rupees(line.amount)}.`
        + ' It stays on the slip at its full amount and stops counting.',
      placeholder: 'Why is it being waived?',
      confirmLabel: 'Waive',
      onSubmit: (reason) => waive.run({ id: line.id, reason }),
    });
  };

  const shiftMonth = (by) => {
    const [y, m] = period.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + by, 1));
    setPeriod(d.toISOString().slice(0, 7));
  };

  const canManage = !mine || role.managesSalary;

  return (
    <Screen
      header={
        <ScreenHeader
          clock=""
          role={role.name}
          title={mine ? 'My Salary' : (data?.employee?.name || 'Salary')}
          subtitle={period}
          badge={row.status ? row.status.toUpperCase() : '—'}
          badgeTone={STATUS_TONE[row.status] || 'neutral'}
          onBack={params.from ? onBack : undefined}
          backLabel={params.backLabel || 'Back'}
        />
      }
      nav={nav}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={COLORS.brand} />
      }
      footer={
        canManage && row.status ? (
          <>
            {row.status === 'draft' ? (
              <ActionButton
                label={finalise.busy ? 'Finalising…' : 'Finalise the month'}
                onPress={finalise.run}
                disabled={finalise.busy}
              />
            ) : null}
            {row.status === 'finalised' ? (
              <ActionButton
                label={approve.busy ? 'Approving…' : 'Approve for payment'}
                onPress={approve.run}
                disabled={approve.busy}
              />
            ) : null}
            {row.status === 'approved' ? (
              <ActionButton
                label={pay.busy ? 'Recording…' : 'Mark paid'}
                onPress={pay.run}
                disabled={pay.busy}
              />
            ) : null}
            {frozen ? (
              <ActionButton
                tone="neutral"
                label={share.busy ? 'Sending…' : 'Share the slip'}
                onPress={share.run}
                disabled={share.busy}
              />
            ) : null}
          </>
        ) : null
      }
    >
      <AsyncBoundary loading={loading} error={error} onRetry={reload}>
        <View style={styles.monthRow}>
          <ActionButton tone="neutral" size="sm" label="‹ Previous" onPress={() => shiftMonth(-1)} />
          <AppText weight="bold" size="sm">{period}</AppText>
          <ActionButton tone="neutral" size="sm" label="Next ›" onPress={() => shiftMonth(1)} />
        </View>

        {!frozen ? (
          <NoticeBar tone="info">
            This month is still a draft — the figures move with every check-in.
            Finalise it to freeze them and enable waivers.
          </NoticeBar>
        ) : null}

        <Card title="Net payable">
          <View style={styles.total}>
            <AppText weight="bold" size="xxl" color={COLORS.text}>{rupees(net)}</AppText>
            <AppText size="xs" color={COLORS.textMuted} style={styles.meta}>
              {`Fixed ${rupees(row.fixed_salary)} · daily rate ${rupees(row.daily_rate)} `
                + '(salary ÷ 26 working days)'}
            </AppText>
          </View>

          <View style={styles.split}>
            <Figure label="Attendance" value={attendance} tone={COLORS.error} />
            <Figure label="Advance" value={advance} tone={COLORS.error} />
            <Figure label="Other" value={row.other_deduction} tone={COLORS.error} />
          </View>
        </Card>

        <Card title="The month">
          <View style={styles.grid}>
            <Stat label="Working days" value={row.working_days} />
            <Stat label="Present" value={row.days_present} />
            <Stat label="Late" value={row.days_late} tone={row.days_late ? COLORS.warning : null} />
            <Stat label="Half days" value={row.half_days} tone={row.half_days ? COLORS.warning : null} />
            <Stat label="Absent (leave)" value={row.days_absent_informed} />
            <Stat
              label="Absent (no word)"
              value={row.days_absent_uninformed}
              tone={row.days_absent_uninformed ? COLORS.error : null}
            />
          </View>
        </Card>

        <Card title={`Deductions (${lines.length})`} flush>
          {lines.length ? lines.map((line, index) => (
            <View
              key={line.id || index}
              style={[styles.row, index ? styles.ruled : null, line.waived ? styles.waived : null]}
            >
              <View style={styles.body}>
                <AppText weight="bold" size="sm">
                  {KIND_LABELS[line.kind] || line.kind}
                </AppText>
                <AppText size="xs" color={COLORS.textMuted} style={styles.meta}>
                  {[line.on_date ? formatDate(line.on_date) : null, line.detail]
                    .filter(Boolean).join(' · ')}
                </AppText>
                {line.waived ? (
                  <AppText size="xs" color={COLORS.success} style={styles.meta}>
                    {`Waived — ${line.waive_reason || 'no reason given'}`}
                  </AppText>
                ) : null}
              </View>

              <View style={styles.amount}>
                <AppText
                  weight="bold"
                  size="sm"
                  color={line.waived ? COLORS.textMuted : COLORS.error}
                  style={line.waived ? styles.struck : null}
                >
                  {rupees(line.amount)}
                </AppText>
                {frozen && !line.waived && canManage
                  && ['draft', 'finalised'].includes(row.status) ? (
                    <ActionButton tone="neutral" size="sm" label="Waive" onPress={() => askWaive(line)} />
                  ) : null}
              </View>
            </View>
          )) : (
            <View style={styles.empty}>
              <AppText size="sm" color={COLORS.textMuted}>
                Nothing deducted this month.
              </AppText>
            </View>
          )}
        </Card>

        {row.status === 'paid' && row.paid_on ? (
          <NoticeBar tone="success">
            {`Paid on ${formatDate(row.paid_on)}.`}
          </NoticeBar>
        ) : null}

        {frozen ? (
          <ActionButton
            tone="neutral"
            label="Open the printable slip"
            onPress={() => Linking.openURL(Payroll.slipPdfUrl(employeeId, period))}
          />
        ) : null}
      </AsyncBoundary>
    </Screen>
  );
}

function Figure({ label, value, tone }) {
  return (
    <View style={styles.figure}>
      <AppText size="xs" color={COLORS.textMuted}>{label}</AppText>
      <AppText weight="bold" size="sm" color={Number(value) > 0 ? tone : COLORS.text}>
        {Number(value) > 0 ? `− ${rupees(value)}` : rupees(0)}
      </AppText>
    </View>
  );
}

function Stat({ label, value, tone }) {
  return (
    <View style={styles.stat}>
      <AppText weight="bold" size="lg" color={tone || COLORS.text}>
        {value ?? 0}
      </AppText>
      <AppText size="xs" color={COLORS.textMuted}>{label}</AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  monthRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  total: { alignItems: 'center', paddingVertical: 6 },
  meta: { marginTop: 3, textAlign: 'center' },
  split: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: COLORS.borderLight,
  },
  figure: { alignItems: 'center', gap: 3 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 14 },
  stat: { width: '33%', alignItems: 'center', gap: 2 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 14, gap: 10 },
  ruled: { borderTopWidth: 1, borderTopColor: COLORS.borderLight },
  waived: { backgroundColor: COLORS.surfaceLight },
  body: { flex: 1 },
  amount: { alignItems: 'flex-end', gap: 4 },
  struck: { textDecorationLine: 'line-through' },
  empty: { padding: 16, alignItems: 'center' },
});
