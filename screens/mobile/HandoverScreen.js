import React from 'react';
import { View, RefreshControl, StyleSheet } from 'react-native';

import { useThemeColors } from '../../context/ThemeContext';
import { Cash } from '../../services/endpoints';
import { useApi, useAction } from '../../hooks/useApi';
import { rupees } from '../../utils/format';
import { formatDate, formatTime, todayString } from '../../utils/datetime';
import { confirmAction } from '../../services/confirm';
import AppText from '../../components/AppText';
import Screen from '../../components/mobile/Screen';
import ScreenHeader from '../../components/mobile/ScreenHeader';
import Card from '../../components/mobile/Card';
import Badge from '../../components/mobile/Badge';
import Field from '../../components/mobile/Field';
import NoticeBar from '../../components/mobile/NoticeBar';
import ActionButton from '../../components/mobile/ActionButton';
import AsyncBoundary from '../../components/mobile/AsyncBoundary';

/**
 * Collection handover — section 8.
 *
 * Two sides of one transaction on one screen, because they are the same
 * transaction and the disagreement between them is the whole point.
 *
 * A salesman declares what he is carrying before he hands it over; Sibu counts
 * it and enters what he actually received. Neither figure is defaulted from the
 * other: pre-filling Sibu's box with the declared amount would make the count a
 * formality, and a difference that nobody typed is a difference nobody found.
 *
 * A mismatch does not pick a side. The handover is marked disputed and both
 * numbers stay on the record — adopting either one would quietly decide who was
 * wrong.
 */

const STATUS_TONE = {
  declared: 'pending',
  received: 'success',
  disputed: 'danger',
};

/** Colorless — the same for either theme, so no useMemo/COLORS dependency. */
const totalStyle = { alignItems: 'center', gap: 2 };

export default function HandoverScreen({ role, nav, onBack }) {
  const COLORS = useThemeColors();
  const styles = React.useMemo(() => StyleSheet.create({
    dayRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    row: { paddingVertical: 12, paddingHorizontal: 14, gap: 10 },
    head: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
    ruled: { borderTopWidth: 1, borderTopColor: COLORS.borderLight },
    body: { flex: 1 },
    meta: { marginTop: 3 },
    count: { gap: 8 },
    countField: { marginBottom: 0 },
    totals: { flexDirection: 'row', justifyContent: 'space-around' },
  }), [COLORS]);

  const [date, setDate] = React.useState(todayString());

  const { data, loading, error, refreshing, reload, refresh } = useApi(
    () => Cash.handovers(date),
    [date]
  );

  // ---- the salesman's declaration ---------------------------------------
  const [cash, setCash] = React.useState('');
  const [chequeCount, setChequeCount] = React.useState('');
  const [chequeValue, setChequeValue] = React.useState('');
  const [note, setNote] = React.useState('');

  const declare = useAction(
    () => Cash.declareHandover({
      cash: Number(cash) || 0,
      cheques: Number(chequeCount) || 0,
      cheque_value: Number(chequeValue) || 0,
      note: note.trim() || null,
    }),
    {
      onDone: reload,
    }
  );

  // ---- Sibu's count ------------------------------------------------------
  const [counted, setCounted] = React.useState({}); // handover id → typed cash
  const [countedCheques, setCountedCheques] = React.useState({});

  const receive = useAction(
    ({ id }) => Cash.receiveHandover(id, {
      cash: Number(counted[id]),
      cheques: Number(countedCheques[id] ?? 0),
    }),
    { onDone: reload }
  );

  const rows = data?.handovers || [];
  const mine = rows.find((h) => h.employee_id === role.key);
  const today = date === todayString();

  // Seed the correction form from what was declared, once per row rather than
  // on every reload — an effect that re-runs on each poll overwrites whatever
  // the user is halfway through typing.
  const seeded = React.useRef(null);
  React.useEffect(() => {
    if (!mine || seeded.current === mine.id) return;
    seeded.current = mine.id;
    setCash(String(Number(mine.declared_cash) || ''));
    setChequeCount(String(Number(mine.declared_cheques) || ''));
    setChequeValue(String(Number(mine.declared_cheque_value) || ''));
    setNote(mine.note || '');
  }, [mine]);

  const shiftDay = (by) => {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + by);
    setDate(d.toISOString().slice(0, 10));
  };

  const askReceive = (row) => {
    const typed = Number(counted[row.id]);
    const gap = typed - Number(row.declared_cash);
    confirmAction(
      gap === 0 ? 'Confirm the count?' : 'The count does not match',
      gap === 0
        ? `${rupees(typed)} from ${row.employee_name}.`
        : `${row.employee_name} declared ${rupees(row.declared_cash)} and you counted `
          + `${rupees(typed)} — ${gap > 0 ? 'a surplus' : 'a shortfall'} of ${rupees(Math.abs(gap))}. `
          + 'Both figures are kept and the handover is marked disputed.',
      () => receive.run({ id: row.id })
    );
  };

  return (
    <Screen
      header={
        <ScreenHeader
          clock=""
          role={role.name}
          title="Handover"
          subtitle={formatDate(date)}
          badge={rupees(data?.received_cash)}
          badgeTone={
            Number(data?.received_cash) === Number(data?.declared_cash) ? 'success' : 'pending'
          }
          onBack={onBack}
        />
      }
      nav={nav}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={COLORS.brand} />
      }
    >
      <View style={styles.dayRow}>
        <ActionButton tone="neutral" size="sm" label="‹ Previous" onPress={() => shiftDay(-1)} />
        <AppText weight="bold" size="sm">{formatDate(date)}</AppText>
        <ActionButton
          tone="neutral"
          size="sm"
          label="Next ›"
          disabled={today}
          onPress={() => shiftDay(1)}
        />
      </View>

      {/* The declaration stays open while it is still only a declaration: the
          route upserts, so a salesman who miscounted his own pocket can correct
          it. Once Sibu has counted, it is a conversation and not a form — and
          the server refuses it then, which is where that rule belongs. */}
      {today && (!mine || mine.status === 'declared') ? (
        <Card title={mine ? 'Correct your declaration' : 'What are you bringing in?'}>
          <Field
            label="Cash"
            value={cash}
            onChangeText={setCash}
            keyboardType="numeric"
            placeholder="0"
            required
          />
          <Field
            label="Cheques (how many)"
            value={chequeCount}
            onChangeText={setChequeCount}
            keyboardType="numeric"
            placeholder="0"
          />
          <Field
            label="Cheques (total value)"
            value={chequeValue}
            onChangeText={setChequeValue}
            keyboardType="numeric"
            placeholder="0"
          />
          <Field label="Note" value={note} onChangeText={setNote} placeholder="Optional" />
          <ActionButton
            label={declare.busy ? 'Declaring…' : 'Declare'}
            onPress={declare.run}
            disabled={declare.busy}
          />
          {declare.error ? <NoticeBar tone="danger">{declare.error}</NoticeBar> : null}
        </Card>
      ) : null}

      {today && mine && mine.status === 'declared' ? (
        <NoticeBar tone="info">
          {`You have declared ${rupees(mine.declared_cash)}. Hand it to Sibu today — `
            + 'he counts it and the two figures are compared.'}
        </NoticeBar>
      ) : null}

      <AsyncBoundary
        loading={loading}
        error={error}
        onRetry={reload}
        empty={!rows.length}
        emptyGlyph="₹"
        emptyText="Nothing declared for this day."
      >
        <Card title="Declared" flush>
          {rows.map((row, index) => {
            const awaiting = row.status === 'declared';
            const canCount = awaiting && role.countsCash && row.employee_id !== role.key;
            const typed = counted[row.id];
            const gap = typed === undefined || typed === ''
              ? null : Number(typed) - Number(row.declared_cash);

            return (
              <View key={row.id} style={[styles.row, index ? styles.ruled : null]}>
                <View style={styles.head}>
                  <View style={styles.body}>
                    <AppText weight="bold" size="sm">{row.employee_name}</AppText>
                    <AppText size="xs" color={COLORS.textMuted} style={styles.meta}>
                      {[
                        `${rupees(row.declared_cash)} cash`,
                        Number(row.declared_cheques) > 0
                          ? `${row.declared_cheques} cheque(s) ${rupees(row.declared_cheque_value)}`
                          : null,
                        row.received_at ? formatTime(row.received_at) : null,
                      ].filter(Boolean).join(' · ')}
                    </AppText>

                    {/* Both figures stay on the record when they disagree. */}
                    {row.status !== 'declared' ? (
                      <AppText
                        size="xs"
                        color={row.status === 'disputed' ? COLORS.error : COLORS.success}
                        style={styles.meta}
                      >
                        {row.status === 'disputed'
                          ? `Counted ${rupees(row.received_cash)} by ${row.received_by_name || '—'}`
                            + ` — ${rupees(Math.abs(Number(row.received_cash) - Number(row.declared_cash)))} apart`
                          : `Counted and agreed by ${row.received_by_name || '—'}`}
                      </AppText>
                    ) : null}

                    {row.note ? (
                      <AppText size="xs" color={COLORS.textMuted} style={styles.meta}>
                        {row.note}
                      </AppText>
                    ) : null}
                  </View>

                  <Badge tone={STATUS_TONE[row.status] || 'neutral'}>
                    {String(row.status).toUpperCase()}
                  </Badge>
                </View>

                {canCount ? (
                  <View style={styles.count}>
                    <Field
                      label="Cash counted"
                      value={typed ?? ''}
                      onChangeText={(v) => setCounted((prev) => ({ ...prev, [row.id]: v }))}
                      keyboardType="numeric"
                      placeholder="Count it, do not copy it"
                      style={styles.countField}
                    />
                    <Field
                      label="Cheques"
                      value={countedCheques[row.id] ?? ''}
                      onChangeText={(v) => setCountedCheques((prev) => ({ ...prev, [row.id]: v }))}
                      keyboardType="numeric"
                      placeholder="0"
                      style={styles.countField}
                    />
                    {gap !== null && gap !== 0 ? (
                      <AppText size="xs" color={COLORS.error}>
                        {`${gap > 0 ? 'Surplus' : 'Short'} ${rupees(Math.abs(gap))}`}
                      </AppText>
                    ) : null}
                    <ActionButton
                      size="sm"
                      label={receive.busy ? 'Recording…' : 'Record the count'}
                      disabled={receive.busy || typed === undefined || typed === ''}
                      onPress={() => askReceive(row)}
                    />
                  </View>
                ) : null}
              </View>
            );
          })}
        </Card>

        <Card title="The day">
          <View style={styles.totals}>
            <Total label="Declared" value={data?.declared_cash} />
            <Total
              label="Counted"
              value={data?.received_cash}
              tone={Number(data?.received_cash) === Number(data?.declared_cash)
                ? COLORS.success : COLORS.warning}
            />
          </View>
        </Card>

        {receive.error ? <NoticeBar tone="danger">{receive.error}</NoticeBar> : null}
      </AsyncBoundary>
    </Screen>
  );
}

function Total({ label, value, tone }) {
  const COLORS = useThemeColors();
  return (
    <View style={totalStyle}>
      <AppText weight="bold" size="lg" color={tone || COLORS.text}>{rupees(value)}</AppText>
      <AppText size="xs" color={COLORS.textMuted}>{label}</AppText>
    </View>
  );
}
