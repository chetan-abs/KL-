import React from 'react';
import { View, TouchableOpacity, RefreshControl, StyleSheet } from 'react-native';

import { useThemeColors } from '../../context/ThemeContext';
import { Dispatch } from '../../services/endpoints';
import { useApi } from '../../hooks/useApi';
import { businessDate, formatTime } from '../../utils/datetime';
import AppText from '../../components/AppText';
import Screen from '../../components/mobile/Screen';
import ScreenHeader from '../../components/mobile/ScreenHeader';
import Card from '../../components/mobile/Card';
import Avatar from '../../components/mobile/Avatar';
import Badge from '../../components/mobile/Badge';
import NoticeBar from '../../components/mobile/NoticeBar';
import AsyncBoundary from '../../components/mobile/AsyncBoundary';

/**
 * 11 — Kamal's route. The order is a suggestion, not a sequence: any stop can be
 * taken next, and the driver reorders as traffic and shop timings demand.
 *
 * So the control on each row is a verb, not a handle — tapping a stop opens it
 * to deliver. Drag-to-reorder was the alternative and it is the wrong instrument
 * on a phone held one-handed in a parked auto.
 *
 * The route is the caller's own: `GET /dispatch/route` is scoped to req.user.id
 * and needs no grant, which is why a driver account holds almost nothing.
 */
function makeSTATE(COLORS) {
  return {
  active: { disc: COLORS.primary, row: COLORS.infoRow, badge: 'info', label: 'Active' },
  pending: { disc: COLORS.actionNeutral, row: COLORS.surface, badge: 'neutral', label: 'Go Next' },
  done: { disc: COLORS.actionApprove, row: COLORS.surface, badge: 'success', label: 'Done' },
  failed: { disc: COLORS.actionReject, row: COLORS.errorRow, badge: 'danger', label: 'Failed' },
};
}

export default function DriverRouteScreen({ role, nav, onOpenStop }) {
  const COLORS = useThemeColors();
  const STATE = React.useMemo(() => makeSTATE(COLORS), [COLORS]);
  const styles = React.useMemo(() => StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 13, paddingHorizontal: 14 },
  ruled: { borderTopWidth: 1, borderTopColor: COLORS.borderLight },
  body: { flex: 1, paddingHorizontal: 11 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  meta: { marginTop: 3 },
}), [COLORS]);
  const { data, loading, error, refreshing, reload, refresh } = useApi(() => Dispatch.myRoute(), []);

  const sheet = data?.sheet;
  const stops = data?.stops || [];
  const remaining = stops.filter((s) => s.state === 'pending' || s.state === 'active').length;

  return (
    <Screen
      header={
        <ScreenHeader
          clock={businessDate()}
          role={role.name}
          title="Today's Route"
          subtitle={
            loading
              ? 'Loading…'
              : sheet
                ? `${stops.length} stops · ${remaining} to go`
                : 'No route released'
          }
          badge={sheet ? 'En route' : 'Idle'}
          badgeTone={sheet ? 'info' : 'onBrand'}
        />
      }
      nav={nav}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={COLORS.brand} />
      }
    >
      <AsyncBoundary
        loading={loading}
        error={error}
        onRetry={reload}
        empty={!sheet || !stops.length}
        emptyGlyph="🚚"
        emptyText="No route has been released for you today. Ajit builds the sheet."
      >
        <NoticeBar tone="info">
          Suggested order shown. Tap any stop to deliver it next.
        </NoticeBar>

        <Card title="Stops" flush>
          {stops.map((stop, index) => {
            const look = STATE[stop.state] || STATE.pending;
            const closed = stop.state === 'done' || stop.state === 'failed';

            return (
              <TouchableOpacity
                key={stop.id}
                style={[styles.row, { backgroundColor: look.row }, index ? styles.ruled : null]}
                onPress={() => (closed ? null : onOpenStop?.(stop))}
                disabled={closed}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={`${stop.party}, ${look.label}`}
              >
                <Avatar
                  label={stop.state === 'done' ? '✓' : stop.state === 'active' ? 'NOW' : String(stop.seq)}
                  color={look.disc}
                  size={38}
                />

                <View style={styles.body}>
                  <View style={styles.titleRow}>
                    <AppText
                      weight="bold"
                      size="sm"
                      color={closed ? COLORS.textMuted : COLORS.text}
                      numberOfLines={1}
                      style={styles.flex}
                    >
                      {stop.party}
                    </AppText>
                    {stop.is_urgent ? (
                      <AppText weight="bold" size="xs" color={COLORS.error}>⚡ Urgent</AppText>
                    ) : null}
                  </View>
                  <AppText size="xs" color={COLORS.textSecondary} style={styles.meta} numberOfLines={1}>
                    {[
                      `#${stop.order_id}`,
                      stop.cartons ? `${stop.cartons} cartons` : null,
                      stop.area,
                      stop.delivered_at ? `Delivered ${formatTime(stop.delivered_at)}` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </AppText>
                </View>

                <Badge tone={look.badge}>{look.label}</Badge>
              </TouchableOpacity>
            );
          })}
        </Card>
      </AsyncBoundary>
    </Screen>
  );
}

