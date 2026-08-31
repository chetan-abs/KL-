import React from 'react';
import { View, TouchableOpacity, StyleSheet } from 'react-native';

import { COLORS } from '../../constants/colors';
import { Payroll } from '../../services/endpoints';
import { useApi } from '../../hooks/useApi';
import { rupees } from '../../utils/format';
import AppText from '../../components/AppText';
import Screen from '../../components/mobile/Screen';
import ScreenHeader from '../../components/mobile/ScreenHeader';
import Card from '../../components/mobile/Card';
import Badge from '../../components/mobile/Badge';
import ActionButton from '../../components/mobile/ActionButton';
import AsyncBoundary from '../../components/mobile/AsyncBoundary';

/**
 * A.1, R-30 — "The net payable salary for each employee each month is
 * reviewed and approved by Yash before any payout is processed."
 *
 * Everyone's month in one list, because R-30's approval is a monthly ritual
 * done across the whole staff at once, not one employee looked up at a time.
 * Opening a row goes to `SalaryScreen` for that employee, which is where
 * finalise/approve/pay actually live — this screen is the register, not a
 * second copy of the workflow.
 */
const STATUS_TONE = {
  draft: 'neutral',
  finalised: 'pending',
  approved: 'info',
  paid: 'success',
};

const thisMonth = () => new Date().toISOString().slice(0, 7);

export default function SalaryRegisterScreen({ role, nav, onBack, onOpenEmployee }) {
  const [period, setPeriod] = React.useState(thisMonth());
  const { data, loading, error, reload } = useApi(() => Payroll.register(period), [period]);
  const rows = data?.rows || [];

  const shiftMonth = (by) => {
    const [y, m] = period.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + by, 1));
    setPeriod(d.toISOString().slice(0, 7));
  };

  return (
    <Screen
      nav={nav}
      header={
        <ScreenHeader
          role={role.name}
          title="Salary Register"
          subtitle={period}
          onBack={onBack}
        />
      }
    >
      <AsyncBoundary loading={loading} error={error} onRetry={reload}>
        <View style={styles.monthRow}>
          <ActionButton tone="neutral" size="sm" label="‹ Previous" onPress={() => shiftMonth(-1)} />
          <AppText weight="bold" size="sm">{period}</AppText>
          <ActionButton tone="neutral" size="sm" label="Next ›" onPress={() => shiftMonth(1)} />
        </View>

        <Card title="Total payable" flush>
          <View style={styles.totalRow}>
            <AppText weight="bold" size="xxl">{rupees(data?.total_payable)}</AppText>
            <AppText size="xs" color={COLORS.textMuted}>{`${rows.length} accounts`}</AppText>
          </View>
        </Card>

        <Card title="Everyone's month" flush>
          {rows.map((row, index) => (
            <TouchableOpacity
              key={row.employee_id}
              style={[styles.row, index ? styles.ruled : null]}
              onPress={() => onOpenEmployee({ employeeId: row.employee_id, period })}
              activeOpacity={0.75}
              accessibilityRole="button"
            >
              <View style={styles.flex}>
                <AppText weight="bold" size="sm">{row.name}</AppText>
                <AppText size="xs" color={COLORS.textSecondary} style={styles.meta}>
                  {row.fixed_salary
                    ? `Fixed ${rupees(row.fixed_salary)}`
                    : 'No salary set — open to set one'}
                </AppText>
              </View>
              <AppText weight="bold" size="sm" style={styles.net}>{rupees(row.net_payable)}</AppText>
              <Badge tone={STATUS_TONE[row.status] || 'neutral'}>{row.status.toUpperCase()}</Badge>
            </TouchableOpacity>
          ))}
        </Card>
      </AsyncBoundary>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  monthRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  totalRow: { padding: 14, alignItems: 'center' },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 12, paddingHorizontal: 14,
  },
  ruled: { borderTopWidth: 1, borderTopColor: COLORS.borderLight },
  meta: { marginTop: 3 },
  net: { marginRight: 2 },
});
