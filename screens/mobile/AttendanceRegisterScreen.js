import React from 'react';
import { View, StyleSheet } from 'react-native';

import { useThemeColors } from '../../context/ThemeContext';
import { Attendance } from '../../services/endpoints';
import { useApi } from '../../hooks/useApi';
import { formatTime, businessDate } from '../../utils/datetime';
import AppText from '../../components/AppText';
import Screen from '../../components/mobile/Screen';
import ScreenHeader from '../../components/mobile/ScreenHeader';
import Card from '../../components/mobile/Card';
import Badge from '../../components/mobile/Badge';
import AsyncBoundary from '../../components/mobile/AsyncBoundary';

/**
 * C.5 — "Manas sees a daily attendance dashboard: who is present, who is
 * late, who is absent. Colour coded: Green (present, on time), Amber (late),
 * Red (absent), Grey (not yet checked in)."
 *
 * `status` arrives computed from `GET /attendance/daily` — the server, not
 * this screen, judges "absent" against the business timezone and each
 * employee's own shift, so a phone set to the wrong zone cannot turn a red
 * into a grey. This screen only maps that word onto a colour.
 */
function makeSTATUS(COLORS) {
  return {
  present: { label: 'Present', tone: 'success', dot: COLORS.success },
  late: { label: 'Late', tone: 'warning', dot: COLORS.warning },
  absent: { label: 'Absent', tone: 'danger', dot: COLORS.error },
  pending: { label: 'Not yet', tone: 'neutral', dot: COLORS.textMuted },
};
}

export default function AttendanceRegisterScreen({ role, nav, onBack }) {
  const COLORS = useThemeColors();
  const STATUS = React.useMemo(() => makeSTATUS(COLORS), [COLORS]);
  const styles = React.useMemo(() => StyleSheet.create({
  flex: { flex: 1 },
  summary: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 16, padding: 14,
  },
  summaryItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 9, height: 9, borderRadius: 5 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 12, paddingHorizontal: 14,
  },
  ruled: { borderTopWidth: 1, borderTopColor: COLORS.borderLight },
  meta: { marginTop: 3 },
}), [COLORS]);
  const { data, loading, error, reload } = useApi(() => Attendance.daily(), []);
  const rows = data?.attendance || [];

  const counts = React.useMemo(() => {
    const c = { present: 0, late: 0, absent: 0, pending: 0 };
    for (const row of rows) c[row.status] = (c[row.status] || 0) + 1;
    return c;
  }, [rows]);

  return (
    <Screen
      nav={nav}
      header={
        <ScreenHeader
          role={role.name}
          title="Attendance"
          subtitle={data?.date || businessDate()}
          onBack={onBack}
        />
      }
    >
      <AsyncBoundary loading={loading} error={error} onRetry={reload} empty={!loading && !rows.length}
        emptyText="No workforce accounts to track.">
        <Card title="Today" flush>
          <View style={styles.summary}>
            {Object.entries(STATUS).map(([key, meta]) => (
              <View key={key} style={styles.summaryItem}>
                <View style={[styles.dot, { backgroundColor: meta.dot }]} />
                <AppText size="sm" color={COLORS.textSecondary}>{meta.label}</AppText>
                <AppText weight="bold" size="md">{counts[key] || 0}</AppText>
              </View>
            ))}
          </View>
        </Card>

        <Card title={`Staff (${rows.length})`} flush>
          {rows.map((row, index) => {
            const meta = STATUS[row.status] || STATUS.pending;
            return (
              <View key={row.id} style={[styles.row, index ? styles.ruled : null]}>
                <View style={[styles.dot, { backgroundColor: meta.dot }]} />
                <View style={styles.flex}>
                  <AppText weight="bold" size="sm">{row.name}</AppText>
                  <AppText size="xs" color={COLORS.textSecondary} style={styles.meta}>
                    {row.checkin_time
                      ? `In ${formatTime(row.checkin_time)}${row.checkout_time ? ` · Out ${formatTime(row.checkout_time)}` : ''}`
                      : 'Not checked in'}
                    {row.is_late ? ` · ${row.late_minutes} min late` : ''}
                    {row.is_half_day ? ' · Half day' : ''}
                  </AppText>
                </View>
                <Badge tone={meta.tone}>{meta.label}</Badge>
              </View>
            );
          })}
        </Card>
      </AsyncBoundary>
    </Screen>
  );
}

