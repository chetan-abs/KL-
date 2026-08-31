import React from 'react';
import { View, StyleSheet } from 'react-native';

import { COLORS } from '../../constants/colors';
import { UNDELIVERED_REASONS } from '../../constants/options';
import { Dispatch } from '../../services/endpoints';
import { useAction } from '../../hooks/useApi';
import { captureAndUpload } from '../../utils/capture';
import { getCurrentLocation } from '../../utils/location';
import { confirmAction, showAlert } from '../../services/confirm';
import Screen from '../../components/mobile/Screen';
import ScreenHeader from '../../components/mobile/ScreenHeader';
import Card from '../../components/mobile/Card';
import DetailRow from '../../components/mobile/DetailRow';
import Field from '../../components/mobile/Field';
import Select from '../../components/mobile/Select';
import Badge from '../../components/mobile/Badge';
import PhotoBox from '../../components/mobile/PhotoBox';
import ActionButton from '../../components/mobile/ActionButton';
import NoticeBar from '../../components/mobile/NoticeBar';

/**
 * 12 — Kamal delivers. The photo is mandatory and the receiver's name is
 * mandatory; there is deliberately no party signature (R06).
 *
 * A signature scrawled on a phone proves nothing about who held it, and chasing
 * one at a shop counter is what made drivers skip proof entirely. A photo of the
 * goods where they were left, plus the name of the person who took them, is
 * evidence a dispute can actually be settled with. Both are enforced by the
 * server too — this screen is the courtesy, not the boundary.
 *
 * Both outcomes live here. Undelivered is not a failure path hidden behind a
 * back button — it is a real result the day must record, so it gets its own
 * reason, its own proof photo, and its own button.
 *
 * A GPS fix rides along where one can be taken, but never blocks the delivery: a
 * godown basement with no signal must not leave the driver unable to close a
 * stop they have physically completed.
 */
export default function DeliveryScreen({ role, stop, onBack, onDone, nav}) {
  const orderId = stop?.order_id;

  const [receiver, setReceiver] = React.useState('');
  const [photoRef, setPhotoRef] = React.useState(null);
  const [reason, setReason] = React.useState(UNDELIVERED_REASONS[0].value);
  const [failPhotoRef, setFailPhotoRef] = React.useState(null);
  const [error, setError] = React.useState(null);

  /** Best-effort position; a delivery is never blocked on it. */
  async function tryFix() {
    try {
      const { latitude, longitude } = await getCurrentLocation();
      return { latitude, longitude };
    } catch {
      return {};
    }
  }

  const capture = useAction(
    async (which) => {
      const ref = await captureAndUpload({ refType: 'order', refId: orderId });
      if (!ref) return null; // cancelled — not a failure
      if (which === 'fail') setFailPhotoRef(ref);
      else setPhotoRef(ref);
      setError(null);
      return ref;
    },
    { onFail: (message) => setError(message) }
  );

  const deliver = useAction(
    async () => {
      const fix = await tryFix();
      return Dispatch.deliver(orderId, {
        received_by: receiver.trim(),
        photo_ref: photoRef,
        ...fix,
      });
    },
    {
      onDone: () => {
        showAlert('Delivered', `#${orderId} marked delivered with photo proof.`);
        onDone?.();
      },
      onFail: (message) => showAlert('Could not mark delivered', message),
    }
  );

  const fail = useAction(
    () =>
      Dispatch.fail(orderId, {
        reason: UNDELIVERED_REASONS.find((r) => r.value === reason)?.label || reason,
        photo_ref: failPhotoRef,
      }),
    {
      onDone: () => {
        showAlert('Undelivered', `#${orderId} recorded as undelivered. Ajit has been notified.`);
        onDone?.();
      },
      onFail: (message) => showAlert('Could not record', message),
    }
  );

  function markDelivered() {
    if (!receiver.trim()) {
      return setError('Who received the goods — the name is mandatory.');
    }
    if (!photoRef) {
      return setError('A photo of the delivered goods is the proof of delivery.');
    }
    setError(null);
    confirmAction(
      'Mark delivered?',
      `#${orderId} received by ${receiver.trim()}. This closes the stop.`,
      deliver.run
    );
  }

  function markUndelivered() {
    const label = UNDELIVERED_REASONS.find((r) => r.value === reason)?.label;
    confirmAction(
      'Mark undelivered?',
      `#${orderId} — ${label}. The stop returns to the sheet and Ajit is notified.`,
      fail.run
    );
  }

  return (
    <Screen
      nav={nav}
      header={
        <ScreenHeader
          clock={`#${orderId}`}
          role={role.name}
          title={`Deliver #${orderId}`}
          subtitle={[stop?.party, stop?.area].filter(Boolean).join(' · ')}
          onBack={onBack}
          backLabel="Route"
          badge="Current"
          badgeTone="info"
        />
      }
    >
      <Card flush>
        <DetailRow label="Cartons" value={String(stop?.cartons ?? '—')} />
        {stop?.address ? <DetailRow label="Address" value={stop.address} /> : null}
        <DetailRow
          label="⚠ Instructions"
          value={stop?.instructions || 'None given'}
          tone={stop?.instructions ? 'warning' : 'muted'}
          last
        />
      </Card>

      <Card title="Delivered to (mandatory)">
        <Field
          value={receiver}
          onChangeText={(next) => {
            setReceiver(next);
            if (error) setError(null);
          }}
          placeholder="Name of the person who received"
          hint="Who received the goods — name mandatory"
        />
      </Card>

      <Card
        title="Delivery photo * (mandatory)"
        right={<Badge tone={photoRef ? 'success' : 'danger'}>{photoRef ? 'Captured' : 'Required'}</Badge>}
      >
        <PhotoBox
          title="Photo of delivered goods"
          caption="No party signature needed"
          captured={Boolean(photoRef)}
          onPress={() => capture.run('deliver')}
        />
        {capture.busy ? (
          <NoticeBar tone="info" glyph="📷" style={styles.spaced}>
            Uploading the photo…
          </NoticeBar>
        ) : null}
      </Card>

      {error ? <NoticeBar tone="danger">{error}</NoticeBar> : null}

      <NoticeBar tone="success">Photo = delivery proof. No signature required.</NoticeBar>

      <ActionButton
        label="Mark Delivered  ✓"
        tone="approve"
        loading={deliver.busy}
        loadingLabel="Recording"
        onPress={markDelivered}
      />

      <Card title="If not delivered">
        <Select value={reason} options={UNDELIVERED_REASONS} onChange={setReason} />
        <PhotoBox
          compact
          glyph="📷"
          title={failPhotoRef ? 'Proof captured' : 'Proof photo (optional)'}
          captured={Boolean(failPhotoRef)}
          onPress={() => capture.run('fail')}
          style={styles.failPhoto}
        />
        <ActionButton
          label="Mark Undelivered  ✗"
          tone="reject"
          loading={fail.busy}
          loadingLabel="Recording"
          onPress={markUndelivered}
          style={styles.failButton}
        />
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  spaced: { marginTop: 11 },
  failPhoto: { marginTop: 11, borderColor: COLORS.border, backgroundColor: COLORS.surfaceLight },
  failButton: { marginTop: 11 },
});
