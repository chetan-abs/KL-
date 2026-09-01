import React from 'react';
import { View, StyleSheet } from 'react-native';

import { useThemeColors } from '../../context/ThemeContext';
import { Picking } from '../../services/endpoints';
import { useApi, useAction } from '../../hooks/useApi';
import { showAlert, confirmAction } from '../../services/confirm';
import AppText from '../../components/AppText';
import Screen from '../../components/mobile/Screen';
import ScreenHeader from '../../components/mobile/ScreenHeader';
import Card from '../../components/mobile/Card';
import QtyBox from '../../components/mobile/QtyBox';
import CircleButton from '../../components/mobile/CircleButton';
import ProgressBar from '../../components/mobile/ProgressBar';
import ActionButton from '../../components/mobile/ActionButton';
import NoticeBar from '../../components/mobile/NoticeBar';
import AsyncBoundary from '../../components/mobile/AsyncBoundary';

/**
 * 07 — Ashish picks. Tick for a full pick, ⚡ for a partial with the quantity
 * typed, ✗ for not found.
 *
 * Every row carries its outcome three ways at once — a tinted background, an
 * inked count box, and a filled disc — because this screen is read while walking
 * a godown holding stock, at arm's length, and any one signal alone is missed.
 *
 * An undecided row shows two pale discs rather than one: there is no default
 * outcome, and pre-selecting "found" would let a hurried picker tick through a
 * shortage that only surfaces at Ajit's count.
 *
 * Counts are held locally and sent on handover rather than per keystroke. The
 * godown has no signal worth relying on, and a request per digit would leave a
 * half-recorded sheet the first time it dropped.
 */
function makeSTATUS_STYLE(COLORS) {
  return {
  done: { row: COLORS.successRow, tone: 'success', glyph: '✓' },
  partial: { row: COLORS.warningRow, tone: 'warning', glyph: '⚡' },
  missing: { row: COLORS.errorRow, tone: 'danger', glyph: '✗' },
  pending: { row: COLORS.surface, tone: 'neutral', glyph: null },
};
}

/** A row's outcome follows from the count, so the two can never disagree. */
function statusFor(picked, need) {
  if (picked === null || picked === undefined || picked === '') return 'pending';
  const count = Number(picked);
  if (!Number.isFinite(count)) return 'pending';
  if (count <= 0) return 'missing';
  if (count >= Number(need)) return 'done';
  return 'partial';
}

export default function PickerScreen({ role, orderId, party, onBack, onHandover, nav}) {
  const COLORS = useThemeColors();
  const STATUS_STYLE = React.useMemo(() => makeSTATUS_STYLE(COLORS), [COLORS]);
  const styles = React.useMemo(() => StyleSheet.create({
  progressWrap: { paddingHorizontal: 14, paddingTop: 12, paddingBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 12, gap: 9 },
  ruled: { borderTopWidth: 1, borderTopColor: COLORS.borderLight },
  body: { flex: 1 },
  meta: { marginTop: 3 },
  choices: { flexDirection: 'row', gap: 6 },
  // Matches the width of the two-disc pair beside it so rows in either state
  // keep their count boxes on the same vertical line.
  mark: { marginLeft: 17, marginRight: 17 },
}), [COLORS]);
  const { data, loading, error, reload } = useApi(() => Picking.sheet(orderId), [orderId]);
  const [picks, setPicks] = React.useState({});

  // Seeded from the server once the sheet arrives, so a part-picked order
  // reopens where it was left rather than blank.
  React.useEffect(() => {
    if (!data?.lines) return;
    const seeded = {};
    for (const line of data.lines) {
      seeded[line.order_item_id] =
        line.picked_qty === null || line.status === 'pending' ? '' : String(Number(line.picked_qty));
    }
    setPicks(seeded);
  }, [data]);

  const rows = (data?.lines || []).map((line) => {
    const picked = picks[line.order_item_id] ?? '';
    return { ...line, picked, state: statusFor(picked, line.need_qty) };
  });

  const done = rows.filter((r) => r.state !== 'pending').length;
  const short = rows.filter((r) => r.state === 'partial' || r.state === 'missing').length;
  const allDecided = rows.length > 0 && done === rows.length;

  const setPicked = (id, value) => setPicks((prev) => ({ ...prev, [id]: value }));

  const handover = useAction(
    async () => {
      await Picking.record(
        orderId,
        rows.map((r) => ({
          order_item_id: r.order_item_id,
          picked_qty: Number(r.picked) || 0,
          rack: r.rack || null,
        }))
      );
      return Picking.handover(orderId);
    },
    {
      onDone: (result) => {
        // 4.2 — verification is exception-based now: most picks clear
        // straight to billing without anybody counting them again.
        showAlert(
          result?.status === 'verified' ? 'Auto-verified' : 'Handed over',
          result?.status === 'verified'
            ? 'Picked in full — verified automatically and sent to billing.'
            : result?.short_lines
              ? `Sent to Sonu with ${result.short_lines} line(s) short of the SO.`
              : `Sent to Sonu for verification — ${(result?.exception_reasons || []).join('; ') || 'flagged for a count'}.`
        );
        onHandover?.();
      },
      onFail: (message) => showAlert('Could not hand over', message),
    }
  );

  function confirmHandover() {
    if (short) {
      confirmAction(
        'Hand over short?',
        `${short} line(s) are short of the SO. A short pick is always counted by Sonu, and the difference is flagged to Yash.`,
        handover.run
      );
      return;
    }
    handover.run();
  }

  return (
    <Screen
      nav={nav}
      header={
        <ScreenHeader
          clock={`#${orderId}`}
          role={role.name}
          title={`Pick #${orderId}`}
          subtitle={party}
          onBack={onBack}
          backLabel="Picks"
          badge="In progress"
          badgeTone="pending"
        />
      }
      footer={
        rows.length ? (
          <ActionButton
            label={
              allDecided
                ? short
                  ? `Bring to Ajit (${short} short)`
                  : 'Bring to Ajit'
                : `Bring to Ajit (${rows.length - done} pending)`
            }
            tone={allDecided && !short ? 'approve' : 'brand'}
            disabled={!allDecided}
            loading={handover.busy}
            loadingLabel="Handing over"
            onPress={confirmHandover}
          />
        ) : null
      }
    >
      <AsyncBoundary
        loading={loading}
        error={error}
        onRetry={reload}
        empty={!rows.length}
        emptyText="This order has no lines to pick."
      >
        <Card title={`Items (${done}/${rows.length} done)`} flush>
          <View style={styles.progressWrap}>
            <ProgressBar value={done} total={rows.length} />
          </View>

          {rows.map((item, index) => {
            const look = STATUS_STYLE[item.state];
            const undecided = item.state === 'pending';

            return (
              <View
                key={item.order_item_id}
                style={[styles.row, { backgroundColor: look.row }, index ? styles.ruled : null]}
              >
                <View style={styles.body}>
                  <AppText weight="bold" size="sm">{item.item_name}</AppText>
                  <AppText
                    size="xs"
                    color={
                      item.state === 'missing'
                        ? COLORS.error
                        : item.state === 'partial'
                          ? COLORS.warningDark
                          : COLORS.textSecondary
                    }
                    style={styles.meta}
                  >
                    {/* Section 7 — the item master's own bin (bin_location),
                        not the picker's own correction (rack, entered only
                        after they pick) — this is what stops a search. */}
                    {[
                      item.bin_location ? `📍 ${item.bin_location}` : null,
                      item.godown ? item.godown : null,
                      `Need ${Number(item.need_qty)}`,
                      item.rack && item.rack !== item.bin_location ? `Found at ${item.rack}` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </AppText>
                </View>

                <QtyBox
                  label="Picked/Need"
                  value={item.picked}
                  onChangeText={(next) => setPicked(item.order_item_id, next.replace(/[^0-9]/g, ''))}
                  target={Number(item.need_qty)}
                  tone={look.tone}
                />

                {undecided ? (
                  <View style={styles.choices}>
                    <CircleButton
                      glyph="✓"
                      tone="success"
                      filled={false}
                      size={34}
                      onPress={() => setPicked(item.order_item_id, String(Number(item.need_qty)))}
                      accessibilityLabel={`${item.item_name}: picked all`}
                    />
                    <CircleButton
                      glyph="✗"
                      tone="danger"
                      filled={false}
                      size={34}
                      onPress={() => setPicked(item.order_item_id, '0')}
                      accessibilityLabel={`${item.item_name}: not found`}
                    />
                  </View>
                ) : (
                  <CircleButton
                    glyph={look.glyph}
                    tone={look.tone}
                    onPress={() => setPicked(item.order_item_id, '')}
                    accessibilityLabel={`${item.item_name}: clear outcome`}
                    style={styles.mark}
                  />
                )}
              </View>
            );
          })}
        </Card>

        {short ? (
          <NoticeBar tone="danger">
            {`${short} line${short > 1 ? 's' : ''} short of the SO. Ajit's count will flag the difference to Yash.`}
          </NoticeBar>
        ) : null}
      </AsyncBoundary>
    </Screen>
  );
}


