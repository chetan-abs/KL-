import React from 'react';
import { View, TouchableOpacity, StyleSheet } from 'react-native';

import { useThemeColors } from '../../context/ThemeContext';
import { Returns } from '../../services/endpoints';
import { useApi, useAction } from '../../hooks/useApi';
import { rupees } from '../../utils/format';
import { relativeTime } from '../../utils/datetime';
import { captureAndUpload } from '../../utils/capture';
import { confirmAction, showAlert } from '../../services/confirm';
import AppText from '../../components/AppText';
import Screen from '../../components/mobile/Screen';
import ScreenHeader from '../../components/mobile/ScreenHeader';
import Card from '../../components/mobile/Card';
import Badge from '../../components/mobile/Badge';
import QtyBox from '../../components/mobile/QtyBox';
import PhotoBox from '../../components/mobile/PhotoBox';
import ActionButton from '../../components/mobile/ActionButton';
import NoticeBar from '../../components/mobile/NoticeBar';
import AsyncBoundary from '../../components/mobile/AsyncBoundary';

/**
 * Section 6, step 2 of 3 — Sonu's (or Hirak's) physical check.
 *
 * This is the step that decides good from damaged, and the step that moves
 * stock: good quantity re-enters sellable stock, damaged quantity goes into
 * its own bucket (6.1) — never both into the same pile. The server also
 * enforces the one rule that matters most here: whoever entered the return
 * cannot be the one approving it, so this screen never even shows you your
 * own entries as something you could act on.
 *
 * Good + damaged does not have to equal what was entered — Sonu may find
 * less than the receiver wrote down, and that difference is exactly what
 * gets flagged in the EOD report rather than silently accepted.
 */
export default function ReturnApprovalScreen({ role, user, nav, onBack }) {
  const COLORS = useThemeColors();
  const styles = React.useMemo(() => StyleSheet.create({
    row: { paddingVertical: 13, paddingHorizontal: 14 },
    ruled: { borderTopWidth: 1, borderTopColor: COLORS.borderLight },
    head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    meta: { marginTop: 4 },
    line: { paddingVertical: 13, paddingHorizontal: 14 },
    lineHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    splitRow: { flexDirection: 'row', gap: 16, marginTop: 10 },
  }), [COLORS]);

  const [selected, setSelected] = React.useState(null);

  const list = useApi(() => Returns.list('pending'), []);
  const detail = useApi(
    () => (selected ? Returns.get(selected) : Promise.resolve(null)),
    [selected],
    { enabled: Boolean(selected) }
  );

  const [split, setSplit] = React.useState({});

  const returns = (list.data?.returns || []).filter((r) => r.created_by !== user?.id);
  const mine = (list.data?.returns || []).filter((r) => r.created_by === user?.id);

  const lines = (detail.data?.lines || []).map((line) => {
    const s = split[line.id] || {};
    const good = Number(s.good ?? '') || 0;
    const damaged = Number(s.damaged ?? '') || 0;
    return { ...line, good: s.good ?? '', damaged: s.damaged ?? '', damagedPhoto: s.damagedPhoto || null, over: good + damaged > Number(line.return_qty) };
  });
  const anyOver = lines.some((l) => l.over);
  const anyDamagedNoPhoto = lines.some((l) => Number(l.damaged) > 0 && !l.damagedPhoto);
  const ready = lines.length > 0 && !anyOver && !anyDamagedNoPhoto;

  const capture = useAction(
    async (lineId) => {
      const ref = await captureAndUpload({ refType: 'sales_return', refId: selected });
      if (!ref) return null;
      setSplit((prev) => ({ ...prev, [lineId]: { ...prev[lineId], damagedPhoto: ref } }));
      return ref;
    },
    { onFail: (message) => showAlert('Could not capture', message) }
  );

  const approve = useAction(
    () =>
      Returns.approve(
        selected,
        lines.map((l) => ({
          return_item_id: l.id,
          good_qty: Number(l.good) || 0,
          damaged_qty: Number(l.damaged) || 0,
          damaged_photo_id: l.damagedPhoto,
        }))
      ),
    {
      onDone: (result) => {
        showAlert(
          'Return checked',
          `Credit note ${result.note_no} raised for ${rupees(result.credit_total)}.`
            + (result.mismatches ? `\n\nDiffers from entry: ${result.mismatches.join('; ')}` : '')
        );
        setSelected(null);
        setSplit({});
        list.reload();
      },
      onFail: (message) => showAlert('Could not approve', message),
    }
  );

  if (selected) {
    return (
      <Screen
        nav={nav}
        header={
          <ScreenHeader
            clock=""
            role={role.name}
            title="Check Return"
            subtitle={detail.data?.return?.party}
            onBack={() => setSelected(null)}
            backLabel="Returns"
            badge="Checking"
            badgeTone="pending"
          />
        }
        footer={
          <ActionButton
            label={ready ? 'Approve & raise credit note' : 'Split good/damaged for every line'}
            tone="brand"
            disabled={!ready}
            loading={approve.busy}
            loadingLabel="Approving"
            onPress={() =>
              confirmAction(
                'Approve this return?',
                'Good stock re-enters the ledger; damaged goes into the damaged bucket. A credit note is raised (pending) for Gaurav.',
                approve.run
              )
            }
          />
        }
      >
        <AsyncBoundary loading={detail.loading} error={detail.error} onRetry={detail.reload}>
          <NoticeBar tone="info">
            {`Entered by ${detail.data?.return?.entered_by_name || 'someone'}. Good + damaged need not equal what was entered — count what is actually there.`}
          </NoticeBar>

          <Card title="Lines" flush>
            {lines.map((line, index) => (
              <View key={line.id} style={[styles.line, index ? styles.ruled : null]}>
                <View style={styles.lineHead}>
                  <AppText weight="bold" size="sm">{line.item_name}</AppText>
                  <AppText size="xs" color={COLORS.textSecondary}>
                    {`Entered ${Number(line.return_qty)} · ${line.reason?.replace(/_/g, ' ')}`}
                  </AppText>
                </View>

                <View style={styles.splitRow}>
                  <QtyBox
                    label="Good"
                    value={line.good}
                    onChangeText={(v) => setSplit((prev) => ({
                      ...prev, [line.id]: { ...prev[line.id], good: v.replace(/[^0-9]/g, '') },
                    }))}
                    target={Number(line.return_qty)}
                    tone={line.over ? 'danger' : 'success'}
                  />
                  <QtyBox
                    label="Damaged"
                    value={line.damaged}
                    onChangeText={(v) => setSplit((prev) => ({
                      ...prev, [line.id]: { ...prev[line.id], damaged: v.replace(/[^0-9]/g, '') },
                    }))}
                    target={Number(line.return_qty)}
                    tone={line.over ? 'danger' : Number(line.damaged) > 0 ? 'warning' : 'neutral'}
                  />
                </View>

                {Number(line.damaged) > 0 ? (
                  <PhotoBox
                    compact
                    glyph="📷"
                    title={line.damagedPhoto ? 'Damage photo captured' : 'Photo of the damage (mandatory)'}
                    captured={Boolean(line.damagedPhoto)}
                    onPress={() => capture.run(line.id)}
                    style={styles.meta}
                  />
                ) : null}

                {line.over ? (
                  <AppText size="xs" color={COLORS.error} style={styles.meta}>
                    {`Good + damaged cannot exceed the ${Number(line.return_qty)} entered.`}
                  </AppText>
                ) : null}
              </View>
            ))}
          </Card>
        </AsyncBoundary>
      </Screen>
    );
  }

  return (
    <Screen
      nav={nav}
      header={
        <ScreenHeader
          clock=""
          role={role.name}
          title="Returns to check"
          subtitle={list.loading ? 'Loading…' : `${returns.length} waiting`}
          onBack={onBack}
          badge={`${returns.length}`}
          badgeTone={returns.length ? 'pending' : 'neutral'}
        />
      }
    >
      <AsyncBoundary
        loading={list.loading}
        error={list.error}
        onRetry={list.reload}
        empty={!returns.length}
        emptyGlyph="↩"
        emptyText="Nothing waiting for a physical check."
      >
        <Card title="Waiting on you" flush>
          {returns.map((r, index) => (
            <TouchableOpacity
              key={r.id}
              style={[styles.row, index ? styles.ruled : null]}
              onPress={() => setSelected(r.id)}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={`Check return from ${r.party}`}
            >
              <View style={styles.head}>
                <AppText weight="bold" size="sm">{r.party}</AppText>
                <Badge tone="pending">Check →</Badge>
              </View>
              <AppText size="xs" color={COLORS.textSecondary} style={styles.meta}>
                {[r.invoice_no, `entered by ${r.entered_by_name}`, relativeTime(r.created_at)].filter(Boolean).join(' · ')}
              </AppText>
            </TouchableOpacity>
          ))}
        </Card>

        {mine.length ? (
          <NoticeBar tone="info">
            {`${mine.length} return(s) you entered are waiting on someone else — you cannot check your own.`}
          </NoticeBar>
        ) : null}
      </AsyncBoundary>
    </Screen>
  );
}
