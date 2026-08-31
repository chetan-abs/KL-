import React from 'react';
import { StyleSheet } from 'react-native';

import { Attendance } from '../../services/endpoints';
import { useApi, useAction } from '../../hooks/useApi';
import { captureAndUploadId } from '../../utils/capture';
import {
  getCurrentLocation, startLocationTracking, stopLocationTracking, describeTrackingState,
} from '../../utils/location';
import { confirmAction, showAlert } from '../../services/confirm';
import { formatTime, shiftHours } from '../../utils/datetime';
import Screen from '../../components/mobile/Screen';
import ScreenHeader from '../../components/mobile/ScreenHeader';
import Card from '../../components/mobile/Card';
import DetailRow from '../../components/mobile/DetailRow';
import Badge from '../../components/mobile/Badge';
import PhotoBox from '../../components/mobile/PhotoBox';
import ActionButton from '../../components/mobile/ActionButton';
import NoticeBar from '../../components/mobile/NoticeBar';
import AsyncBoundary from '../../components/mobile/AsyncBoundary';

/**
 * Attendance — section 6, C.1–C.5, R-24, R-25.
 *
 * Every staff member's own check-in, lunch break and check-out for today. No
 * check-in or check-out is valid without a geotagged photograph (R-24) — the
 * photo is captured and uploaded first, and the check-in/out call is refused
 * without an id the caller uploaded themselves (`routes/attendance.js`).
 *
 * A GPS fix is mandatory here, unlike the delivery screen's best-effort one:
 * `readFix` in the route rejects a check-in with no coordinates, because the
 * fix — not a signature, not a manager's word — is what "geotagged" means for
 * this rule.
 */
export default function AttendanceScreen({ role, nav, onBack }) {
  const { data, loading, error, reload } = useApi(Attendance.today, []);
  const checkin = data?.checkin || null;
  const doneForDay = Boolean(checkin?.checkout_time);
  const onLunchBreak = Boolean(checkin?.lunch_out_time && !checkin?.lunch_in_time);

  const [photoId, setPhotoId] = React.useState(null);
  const [captureError, setCaptureError] = React.useState(null);

  const capture = useAction(
    async () => {
      const id = await captureAndUploadId({ refType: 'checkin', refId: null });
      if (!id) return null; // cancelled, not a failure
      setPhotoId(id);
      setCaptureError(null);
      return id;
    },
    { onFail: (message) => setCaptureError(message) }
  );

  /** Thrown, not best-effort — the route refuses a check-in with no fix. */
  async function requireFix() {
    try {
      const { latitude, longitude } = await getCurrentLocation();
      return { latitude, longitude };
    } catch {
      throw new Error('Location is required to check in. Enable location and try again.');
    }
  }

  const checkIn = useAction(
    async () => {
      const fix = await requireFix();
      const result = await Attendance.checkIn({ ...fix, photoId });
      // Best-effort: a check-in must succeed on its own even where background
      // tracking cannot start (web, a declined permission).
      const tracking = await startLocationTracking();
      return { result, trackingNote: describeTrackingState(tracking.reason) };
    },
    {
      onDone: ({ result, trackingNote }) => {
        setPhotoId(null);
        showAlert(
          result?.is_late ? 'Checked in — late' : 'Checked in',
          [result?.message, trackingNote].filter(Boolean).join('\n\n')
        );
        reload();
      },
      onFail: (message) => showAlert('Could not check in', message),
    }
  );

  const checkOut = useAction(
    async () => {
      const fix = await requireFix();
      const result = await Attendance.checkOut({ ...fix, photoId });
      await stopLocationTracking();
      return result;
    },
    {
      onDone: (result) => {
        setPhotoId(null);
        showAlert(result?.is_half_day ? 'Checked out — half day' : 'Checked out', result?.message);
        reload();
      },
      onFail: (message) => showAlert('Could not check out', message),
    }
  );

  const lunch = useAction(
    async (which) => {
      const fix = await requireFix();
      return which === 'out' ? Attendance.lunchOut(fix) : Attendance.lunchIn(fix);
    },
    {
      onDone: (result) => {
        reload();
        showAlert('Recorded', result?.message);
      },
      onFail: (message) => showAlert('Could not record', message),
    }
  );

  function confirmCheckIn() {
    if (!photoId) return setCaptureError('Take a photograph first.');
    setCaptureError(null);
    confirmAction(
      'Check in?',
      'This records your arrival with the photo and your current location.',
      checkIn.run
    );
  }

  function confirmCheckOut() {
    if (!photoId) return setCaptureError('Take a photograph first.');
    setCaptureError(null);
    confirmAction('Check out?', 'This closes your shift for today.', checkOut.run);
  }

  return (
    <Screen
      nav={nav}
      header={
        <ScreenHeader
          role={role.name}
          title="Attendance"
          subtitle={data?.businessDate}
          onBack={onBack}
          backLabel="Profile"
          badge={doneForDay ? 'Day closed' : checkin ? 'Checked in' : 'Not checked in'}
          badgeTone={doneForDay ? 'neutral' : checkin ? 'success' : 'warning'}
        />
      }
    >
      <AsyncBoundary loading={loading} error={error} onRetry={reload}>
        {checkin ? (
          <Card title="Today" flush>
            <DetailRow
              label="Checked in"
              value={formatTime(checkin.checkin_time)}
              tone={checkin.is_late ? 'warning' : 'default'}
            />
            {checkin.is_late ? (
              <DetailRow label="Late by" value={`${checkin.late_minutes} min`} tone="warning" />
            ) : null}
            {checkin.lunch_out_time ? (
              <DetailRow label="Lunch out" value={formatTime(checkin.lunch_out_time)} />
            ) : null}
            {checkin.lunch_in_time ? (
              <DetailRow label="Lunch in" value={formatTime(checkin.lunch_in_time)} />
            ) : null}
            {doneForDay ? (
              <>
                <DetailRow
                  label="Checked out"
                  value={formatTime(checkin.checkout_time)}
                  tone={checkin.is_half_day ? 'warning' : 'default'}
                />
                <DetailRow
                  label="Hours worked"
                  value={`${shiftHours(checkin) ?? '—'} h`}
                  tone={checkin.is_half_day ? 'warning' : 'default'}
                  last
                />
              </>
            ) : (
              <DetailRow label="Status" value="On shift" tone="success" last />
            )}
          </Card>
        ) : null}

        {checkin?.is_half_day ? (
          <NoticeBar tone="warning">
            Checked out before the shift cut-off — recorded as a half day.
          </NoticeBar>
        ) : null}
        {checkin?.location_flagged ? (
          <NoticeBar tone="warning">
            Your check-in location was away from the usual workplace. {checkin.location_note}
          </NoticeBar>
        ) : null}

        {doneForDay ? (
          <NoticeBar tone="success">Your day is closed. See you tomorrow.</NoticeBar>
        ) : (
          <Card
            title={checkin ? 'Check out' : 'Check in'}
            right={<Badge tone={photoId ? 'success' : 'danger'}>{photoId ? 'Captured' : 'Required'}</Badge>}
          >
            <PhotoBox
              glyph="🤳"
              title="Photo of yourself"
              caption="Geotagged automatically — mandatory"
              captured={Boolean(photoId)}
              onPress={capture.run}
            />
            {capture.busy ? (
              <NoticeBar tone="info" glyph="📷" style={styles.spaced}>
                Uploading the photo…
              </NoticeBar>
            ) : null}
            {captureError ? (
              <NoticeBar tone="danger" style={styles.spaced}>{captureError}</NoticeBar>
            ) : null}

            {!checkin ? (
              <ActionButton
                label="Check In  →"
                tone="approve"
                loading={checkIn.busy}
                loadingLabel="Checking in"
                onPress={confirmCheckIn}
                style={styles.spaced}
              />
            ) : (
              <ActionButton
                label="Check Out  →"
                tone="reject"
                loading={checkOut.busy}
                loadingLabel="Checking out"
                onPress={confirmCheckOut}
                style={styles.spaced}
              />
            )}
          </Card>
        )}

        {checkin && !doneForDay ? (
          <Card title="Lunch break">
            {onLunchBreak ? (
              <ActionButton
                label="Back from lunch"
                tone="brand"
                loading={lunch.busy}
                loadingLabel="Recording"
                onPress={() => lunch.run('in')}
              />
            ) : (
              <ActionButton
                label="Going for lunch"
                tone="neutral"
                loading={lunch.busy}
                loadingLabel="Recording"
                disabled={Boolean(checkin.lunch_in_time)}
                onPress={() => lunch.run('out')}
              />
            )}
          </Card>
        ) : null}
      </AsyncBoundary>
    </Screen>
  );
}

const styles = StyleSheet.create({
  spaced: { marginTop: 11 },
});
