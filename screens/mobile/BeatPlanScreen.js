import React from 'react';
import { View, TouchableOpacity, RefreshControl, StyleSheet } from 'react-native';

import { COLORS } from '../../constants/colors';
import { Field as FieldApi, Customers } from '../../services/endpoints';
import { useApi, useAction } from '../../hooks/useApi';
import { businessDate, formatTime } from '../../utils/datetime';
import {
  BACKGROUND_TRACKING_SUPPORTED,
  getCurrentLocation,
  describeTrackingState,
} from '../../utils/location';
import { showAlert } from '../../services/confirm';
import AppText from '../../components/AppText';
import Screen from '../../components/mobile/Screen';
import ScreenHeader from '../../components/mobile/ScreenHeader';
import Card from '../../components/mobile/Card';
import Avatar from '../../components/mobile/Avatar';
import Badge from '../../components/mobile/Badge';
import ProgressBar from '../../components/mobile/ProgressBar';
import NoticeBar from '../../components/mobile/NoticeBar';
import ActionButton from '../../components/mobile/ActionButton';
import AsyncBoundary from '../../components/mobile/AsyncBoundary';

/**
 * 19 — Beat plan, over the existing tracking stack.
 *
 * This is the one screen that reuses the old app's GPS work rather than
 * replacing it: `utils/location.js` still owns permissions and fixes.
 *
 * A failed fix is surfaced, never substituted. The util throws rather than
 * returning a fallback coordinate — it used to answer with Mumbai's, which a
 * Guwahati business then wrote into an attendance record as a confirmed
 * position. A visit can still be marked without one; the fix is evidence, not a
 * gate, and a shop in a basement must not be unmarkable.
 *
 * Background tracking does not exist on web, and the banner says so instead of
 * claiming a fix it cannot take.
 */
const STATE = {
  done: { disc: COLORS.actionApprove, badge: 'success', label: 'Done' },
  next: { disc: COLORS.primary, badge: 'info', label: 'Next' },
  planned: { disc: COLORS.actionNeutral, badge: 'neutral', label: 'Planned' },
  skipped: { disc: COLORS.actionNeutral, badge: 'neutral', label: 'Skipped' },
};

export default function BeatPlanScreen({ role, nav }) {
  const plan = useApi(() => FieldApi.beat(), []);
  const parties = useApi(() => Customers.list({ limit: 100 }), []);

  const [fix, setFix] = React.useState(null);
  const [fixError, setFixError] = React.useState(null);

  const stops = plan.data?.stops || [];
  const covered = stops.filter((s) => s.state === 'done').length;

  const takeFix = useAction(
    async () => {
      const location = await getCurrentLocation();
      setFix(location);
      setFixError(null);
      return location;
    },
    { onFail: (message) => { setFix(null); setFixError(message); } }
  );

  const file = useAction(
    () =>
      FieldApi.fileBeat({
        beat_name: 'Today’s round',
        customer_ids: (parties.data?.customers || []).slice(0, 8).map((c) => c.masterid),
      }),
    {
      onDone: () => {
        showAlert('Beat filed', 'Your round for today is set.');
        plan.reload();
      },
      onFail: (message) => showAlert('Could not file', message),
    }
  );

  const visit = useAction(
    (stopId) =>
      FieldApi.visit(stopId, {
        latitude: fix?.latitude ?? null,
        longitude: fix?.longitude ?? null,
      }),
    {
      onDone: () => plan.reload(),
      onFail: (message) => showAlert('Could not record', message),
    }
  );

  return (
    <Screen
      header={
        <ScreenHeader
          clock={businessDate()}
          role={role.name}
          title="Beat Plan"
          subtitle={plan.data?.plan?.beat_name || (plan.loading ? 'Loading…' : 'No beat filed')}
          badge={stops.length ? `${covered}/${stops.length}` : 'Empty'}
          badgeTone="onBrand"
        />
      }
      nav={nav}
      refreshControl={
        <RefreshControl refreshing={plan.refreshing} onRefresh={plan.refresh} tintColor={COLORS.brand} />
      }
      footer={
        stops.length ? (
          <ActionButton
            label={fix ? `GPS fixed · ±${Math.round(fix.accuracy || 0)} m` : 'Get GPS fix'}
            tone={fix ? 'approve' : 'brand'}
            loading={takeFix.busy}
            loadingLabel="Reading GPS"
            onPress={takeFix.run}
          />
        ) : (
          <ActionButton
            label="File today's beat"
            tone="brand"
            loading={file.busy}
            onPress={file.run}
          />
        )
      }
    >
      {!BACKGROUND_TRACKING_SUPPORTED ? (
        <NoticeBar tone="warning">{describeTrackingState('web')}</NoticeBar>
      ) : null}

      {fixError ? <NoticeBar tone="danger">{fixError}</NoticeBar> : null}

      {fix ? (
        <NoticeBar tone="success">
          {`GPS fixed · ${fix.latitude.toFixed(5)}, ${fix.longitude.toFixed(5)} · ±${Math.round(fix.accuracy || 0)} m`}
        </NoticeBar>
      ) : null}

      <AsyncBoundary
        loading={plan.loading}
        error={plan.error}
        onRetry={plan.reload}
        empty={!stops.length}
        emptyGlyph="📍"
        emptyText="No beat filed for today. File one to start the round."
      >
        <Card title="Coverage">
          <View style={styles.coverHead}>
            <AppText weight="bold" size="lg" color={COLORS.brand}>
              {`${covered} of ${stops.length}`}
            </AppText>
            <AppText size="sm" color={COLORS.textSecondary}>stops covered</AppText>
          </View>
          <ProgressBar value={covered} total={stops.length} style={styles.coverBar} />
        </Card>

        <Card title="Stops" flush>
          {stops.map((stop, index) => {
            const look = STATE[stop.state] || STATE.planned;
            const done = stop.state === 'done';

            return (
              <TouchableOpacity
                key={stop.id}
                style={[styles.row, index ? styles.ruled : null, stop.state === 'next' ? styles.next : null]}
                onPress={() => (done ? null : visit.run(stop.id))}
                disabled={done || visit.busy}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={`${stop.party}, ${look.label}${done ? '' : ' — mark visited'}`}
              >
                <Avatar
                  label={done ? '✓' : String(index + 1)}
                  color={look.disc}
                  size={34}
                />
                <View style={styles.body}>
                  <AppText
                    weight="bold"
                    size="sm"
                    color={done ? COLORS.textMuted : COLORS.text}
                    numberOfLines={1}
                  >
                    {stop.party}
                  </AppText>
                  <AppText size="xs" color={COLORS.textSecondary} style={styles.meta}>
                    {[stop.area, stop.visited_at ? formatTime(stop.visited_at) : null]
                      .filter(Boolean)
                      .join(' · ') || 'No area set'}
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

const styles = StyleSheet.create({
  coverHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  coverBar: { marginTop: 10 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 14 },
  ruled: { borderTopWidth: 1, borderTopColor: COLORS.borderLight },
  next: { backgroundColor: COLORS.infoRow },
  body: { flex: 1, paddingHorizontal: 11 },
  meta: { marginTop: 3 },
});
