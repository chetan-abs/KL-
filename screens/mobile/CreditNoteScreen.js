import React from 'react';
import { View, TouchableOpacity, RefreshControl, StyleSheet } from 'react-native';

import { COLORS } from '../../constants/colors';
import { Billing } from '../../services/endpoints';
import { useApi, useAction } from '../../hooks/useApi';
import { rupees } from '../../utils/format';
import { formatDate } from '../../utils/datetime';
import { confirmAction, showAlert } from '../../services/confirm';
import AppText from '../../components/AppText';
import Screen from '../../components/mobile/Screen';
import ScreenHeader from '../../components/mobile/ScreenHeader';
import Card from '../../components/mobile/Card';
import Badge from '../../components/mobile/Badge';
import Avatar from '../../components/mobile/Avatar';
import ActionButton from '../../components/mobile/ActionButton';
import NoticeBar from '../../components/mobile/NoticeBar';
import AsyncBoundary from '../../components/mobile/AsyncBoundary';

/**
 * 17 — Gaurav's credit notes.
 *
 * A pending note is one the party has been promised but the ledger has not yet
 * been told about, so pending rows are tinted and carry the issue action while
 * issued ones go quiet. The distinction is not cosmetic: only an *issued* note
 * moves `closing_balance`, because until it is issued the credit is not yet
 * money the party may set against their account. An unissued credit at month end
 * is an understated liability, and it is the only figure here that can still be
 * wrong.
 */
export default function CreditNoteScreen({ role, nav, onNewReturn }) {
  const { data, loading, error, refreshing, reload, refresh } = useApi(
    () => Billing.creditNotes(),
    []
  );

  const notes = data?.credit_notes || [];
  const pending = notes.filter((n) => n.status === 'pending');
  const pendingValue = pending.reduce((sum, n) => sum + Number(n.amount), 0);

  const issue = useAction((id) => Billing.issueCreditNote(id), {
    onDone: () => {
      showAlert('Credit note issued', 'The party’s balance has been reduced.');
      reload();
    },
    onFail: (message) => showAlert('Could not issue', message),
  });

  return (
    <Screen
      header={
        <ScreenHeader
          clock=""
          role={role.name}
          title="Credit Notes"
          subtitle={loading ? 'Loading…' : `${pending.length} awaiting issue`}
          badge={pending.length ? `${pending.length} pending` : 'Clear'}
          badgeTone={pending.length ? 'pending' : 'success'}
        />
      }
      nav={nav}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={COLORS.brand} />
      }
      footer={<ActionButton label="New Sales Return  →" tone="brand" onPress={onNewReturn} />}
    >
      <AsyncBoundary
        loading={loading}
        error={error}
        onRetry={reload}
        empty={!notes.length}
        emptyGlyph="↩"
        emptyText="No credit notes raised yet."
      >
        {pending.length ? (
          <NoticeBar tone="warning">
            {`${rupees(pendingValue)} promised but not yet posted to the ledger. Until issued, the party's balance still shows it as owed.`}
          </NoticeBar>
        ) : null}

        <Card title="Notes" flush>
          {notes.map((note, index) => {
            const open = note.status === 'pending';
            return (
              <View
                key={note.id}
                style={[styles.row, index ? styles.ruled : null, open ? styles.open : null]}
              >
                <Avatar name={note.party} size={38} />

                <View style={styles.body}>
                  <View style={styles.head}>
                    <AppText weight="bold" size="sm" numberOfLines={1} style={styles.flex}>
                      {note.party}
                    </AppText>
                    <AppText weight="bold" size="sm" color={open ? COLORS.warningDark : COLORS.text}>
                      {rupees(note.amount)}
                    </AppText>
                  </View>

                  <AppText size="xs" color={COLORS.textSecondary} style={styles.meta}>
                    {[note.note_no, note.invoice_no ? `against ${note.invoice_no}` : null, formatDate(note.note_date)]
                      .filter(Boolean)
                      .join(' · ')}
                  </AppText>

                  {note.reason ? (
                    <AppText size="xs" color={COLORS.textMuted} style={styles.meta} numberOfLines={1}>
                      {note.reason}
                    </AppText>
                  ) : null}

                  <View style={styles.foot}>
                    <Badge tone={open ? 'pending' : 'success'}>
                      {open ? 'Pending' : 'Issued'}
                    </Badge>
                    {open ? (
                      <TouchableOpacity
                        disabled={issue.busy}
                        onPress={() =>
                          confirmAction(
                            'Issue this credit note?',
                            `${note.party} — ${rupees(note.amount)}. Their balance drops by this amount.`,
                            () => issue.run(note.id)
                          )
                        }
                        accessibilityRole="button"
                        accessibilityLabel={`Issue ${note.note_no}`}
                      >
                        <AppText weight="bold" size="xs" color={COLORS.primary}>Issue →</AppText>
                      </TouchableOpacity>
                    ) : null}
                  </View>
                </View>
              </View>
            );
          })}
        </Card>
      </AsyncBoundary>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', paddingVertical: 13, paddingHorizontal: 14 },
  ruled: { borderTopWidth: 1, borderTopColor: COLORS.borderLight },
  open: { backgroundColor: COLORS.warningRow },
  body: { flex: 1, paddingLeft: 11 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  meta: { marginTop: 3 },
  foot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 },
});
