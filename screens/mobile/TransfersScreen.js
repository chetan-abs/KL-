import React from 'react';
import { View, RefreshControl, StyleSheet } from 'react-native';

import { useThemeColors } from '../../context/ThemeContext';
import { Transfers } from '../../services/endpoints';
import { useApi, useAction } from '../../hooks/useApi';
import { formatDateTime } from '../../utils/datetime';
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
 * Internal transfers — R-14.
 *
 * "Stock moved between the shop and the godown must be journalled the same
 * day." So the screen leads with what has been received and not yet journalled,
 * because that is the only state the rule can be broken from.
 *
 * The received quantity is typed, never defaulted from what was sent. A
 * pre-filled figure that only has to be confirmed is not a count — it is a
 * signature on somebody else's number, and the shortfall the transfer exists to
 * catch would be invisible.
 */

const STATUS_TONE = {
  sent: 'pending',
  received: 'success',
  cancelled: 'neutral',
};

export default function TransfersScreen({ role, nav, onBack }) {
  const COLORS = useThemeColors();
  const styles = React.useMemo(() => StyleSheet.create({
  row: { flexDirection: 'row', paddingVertical: 12, paddingHorizontal: 14, gap: 10 },
  line: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 14, gap: 10 },
  ruled: { borderTopWidth: 1, borderTopColor: COLORS.borderLight },
  body: { flex: 1 },
  meta: { marginTop: 3 },
  qty: { width: 90 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 10 },
}), [COLORS]);
  const [open, setOpen] = React.useState(null);   // transfer id being received
  const [counts, setCounts] = React.useState({}); // line id → typed quantity

  const list = useApi(() => Transfers.list(), []);
  const detail = useApi(() => (open ? Transfers.get(open) : Promise.resolve(null)), [open]);

  const receive = useAction(
    () => Transfers.receive(open, (detail.data?.lines || []).map((line) => ({
      id: line.id,
      received_qty: Number(counts[line.id] ?? line.sent_qty),
    }))),
    {
      onDone: () => { setOpen(null); setCounts({}); list.reload(); },
    }
  );

  const journal = useAction((id) => Transfers.journal(id), { onDone: list.reload });

  const rows = list.data?.transfers || [];
  const awaitingJournal = rows.filter((t) => t.status === 'received' && !t.journal_done_at);
  const overdue = awaitingJournal.filter((t) => t.journal_overdue);

  // The sender cannot receive their own transfer — the server refuses it, so
  // the button is not drawn rather than drawn and 403'd.
  const receivable = (t) => t.status === 'sent' && t.sent_by !== role.key;

  const lines = detail.data?.lines || [];
  const short = lines.filter(
    (l) => Number(counts[l.id] ?? l.sent_qty) < Number(l.sent_qty)
  );

  return (
    <Screen
      header={
        <ScreenHeader
          clock=""
          role={role.name}
          title="Transfers"
          subtitle={`${rows.length} on record`}
          badge={overdue.length ? `${overdue.length} OVERDUE` : `${awaitingJournal.length} TO JOURNAL`}
          badgeTone={overdue.length ? 'danger' : (awaitingJournal.length ? 'pending' : 'success')}
          onBack={open ? () => { setOpen(null); setCounts({}); } : onBack}
          backLabel={open ? 'Transfers' : 'Back'}
        />
      }
      nav={nav}
      refreshControl={
        <RefreshControl
          refreshing={list.refreshing}
          onRefresh={list.refresh}
          tintColor={COLORS.brand}
        />
      }
      footer={
        open ? (
          <ActionButton
            label={receive.busy ? 'Recording…' : 'Confirm the count'}
            onPress={receive.run}
            disabled={receive.busy}
          />
        ) : null
      }
    >
      {open ? (
        <AsyncBoundary loading={detail.loading} error={detail.error} onRetry={detail.reload}>
          <NoticeBar tone="info">
            Count what actually arrived. Anything less than was sent is recorded
            as a shortfall against the transfer, not quietly absorbed.
          </NoticeBar>

          <Card title={`Transfer #${open}`} flush>
            {lines.map((line, index) => {
              const typed = counts[line.id] ?? String(line.sent_qty);
              const isShort = Number(typed) < Number(line.sent_qty);
              return (
                <View key={line.id} style={[styles.line, index ? styles.ruled : null]}>
                  <View style={styles.body}>
                    <AppText weight="bold" size="sm">{line.item_name}</AppText>
                    <AppText size="xs" color={COLORS.textMuted} style={styles.meta}>
                      {`Sent ${Number(line.sent_qty)}`}
                    </AppText>
                  </View>
                  <Field
                    value={String(typed)}
                    onChangeText={(v) => setCounts((prev) => ({ ...prev, [line.id]: v }))}
                    keyboardType="numeric"
                    style={styles.qty}
                  />
                  {isShort ? <Badge tone="danger">SHORT</Badge> : null}
                </View>
              );
            })}
          </Card>

          {short.length ? (
            <NoticeBar tone="warning">
              {`${short.length} line${short.length > 1 ? 's are' : ' is'} short of what was sent. `
                + 'The difference is recorded and the owner is told.'}
            </NoticeBar>
          ) : null}

          {receive.error ? <NoticeBar tone="danger">{receive.error}</NoticeBar> : null}
        </AsyncBoundary>
      ) : (
        <AsyncBoundary
          loading={list.loading}
          error={list.error}
          onRetry={list.reload}
          empty={!rows.length}
          emptyGlyph="⇄"
          emptyText="No stock has moved between premises."
        >
          {overdue.length ? (
            <NoticeBar tone="danger">
              {`${overdue.length} transfer${overdue.length > 1 ? 's were' : ' was'} received `
                + 'before today and still has no journal entry. R-14 asks for the same day.'}
            </NoticeBar>
          ) : null}

          <Card title="Transfers" flush>
            {rows.map((t, index) => (
              <View key={t.id} style={[styles.row, index ? styles.ruled : null]}>
                <View style={styles.body}>
                  <AppText weight="bold" size="sm">
                    {`#${t.id} · ${t.from_godown} → ${t.to_godown}`}
                  </AppText>
                  <AppText size="xs" color={COLORS.textMuted} style={styles.meta}>
                    {[
                      `${t.line_count} line${Number(t.line_count) === 1 ? '' : 's'}`,
                      t.sent_by_name ? `sent by ${t.sent_by_name}` : null,
                      t.received_at ? formatDateTime(t.received_at) : null,
                    ].filter(Boolean).join(' · ')}
                  </AppText>

                  <View style={styles.actions}>
                    {receivable(t) ? (
                      <ActionButton
                        size="sm"
                        label="Receive"
                        onPress={() => { setOpen(t.id); setCounts({}); }}
                      />
                    ) : null}
                    {t.status === 'received' && !t.journal_done_at && role.journalsTransfers ? (
                      <ActionButton
                        tone="neutral"
                        size="sm"
                        label={journal.busy ? 'Posting…' : 'Journal it'}
                        disabled={journal.busy}
                        onPress={() => confirmAction(
                          'Journal this transfer?',
                          'This records the movement in the books. R-14 wants it the same day.',
                          () => journal.run(t.id)
                        )}
                      />
                    ) : null}
                  </View>
                </View>

                <Badge tone={t.journal_overdue ? 'danger' : (STATUS_TONE[t.status] || 'neutral')}>
                  {t.journal_done_at ? 'JOURNALLED'
                    : t.journal_overdue ? 'OVERDUE'
                      : String(t.status).toUpperCase()}
                </Badge>
              </View>
            ))}
          </Card>
        </AsyncBoundary>
      )}
    </Screen>
  );
}

