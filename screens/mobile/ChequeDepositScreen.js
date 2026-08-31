import React from 'react';
import { View, TouchableOpacity, RefreshControl, StyleSheet } from 'react-native';

import { COLORS } from '../../constants/colors';
import { Cash } from '../../services/endpoints';
import { useApi, useAction } from '../../hooks/useApi';
import { rupees } from '../../utils/format';
import { formatDate } from '../../utils/datetime';
import { confirmAction, showAlert } from '../../services/confirm';
import AppText from '../../components/AppText';
import Screen from '../../components/mobile/Screen';
import ScreenHeader from '../../components/mobile/ScreenHeader';
import Card from '../../components/mobile/Card';
import StatRow from '../../components/mobile/StatRow';
import Badge from '../../components/mobile/Badge';
import ActionButton from '../../components/mobile/ActionButton';
import NoticeBar from '../../components/mobile/NoticeBar';
import AsyncBoundary from '../../components/mobile/AsyncBoundary';

/**
 * 23 — Cheques in hand, and where each one is.
 *
 * Four states, and only the first is actionable: collected but not banked,
 * banked and waiting, cleared, bounced. A bounced cheque is the one that must
 * not be lost in the list, so it keeps a red row and stays at full strength
 * while cleared rows go quiet — the money is not in, the party still owes it,
 * and somebody has to be told.
 *
 * Marking a bounce also reverses any receipt that cheque paid for, server-side,
 * so the party's balance stops claiming money that never arrived. Tapping a row
 * is how a cheque moves state.
 */
const STATE = {
  to_deposit: { badge: 'pending', label: 'To deposit', row: COLORS.warningRow, next: 'deposited', verb: 'Deposit' },
  deposited: { badge: 'info', label: 'Deposited', row: COLORS.surface, next: 'cleared', verb: 'Mark cleared' },
  cleared: { badge: 'success', label: 'Cleared', row: COLORS.surface, next: null },
  bounced: { badge: 'danger', label: 'Bounced', row: COLORS.errorRow, next: null },
};

export default function ChequeDepositScreen({ role, nav }) {
  const { data, loading, error, refreshing, reload, refresh } = useApi(() => Cash.cheques(), []);
  const cheques = data?.cheques || [];

  const setStatus = useAction(({ id, status }) => Cash.setChequeStatus(id, status), {
    onDone: reload,
    onFail: (message) => showAlert('Could not update', message),
  });

  const pending = cheques.filter((c) => c.status === 'to_deposit');
  const bounced = cheques.filter((c) => c.status === 'bounced');
  const cleared = cheques.filter((c) => c.status === 'cleared');
  const pendingValue = pending.reduce((sum, c) => sum + Number(c.amount), 0);

  function act(cheque) {
    const look = STATE[cheque.status];
    if (!look?.next) return;

    confirmAction(
      `${look.verb}?`,
      `${cheque.party} — ${cheque.cheque_no} for ${rupees(cheque.amount)}.`,
      () => setStatus.run({ id: cheque.id, status: look.next })
    );
  }

  function bounce(cheque) {
    confirmAction(
      'Mark this cheque bounced?',
      `${cheque.party} — ${rupees(cheque.amount)}. Any receipt against it is reversed and the balance goes back up.`,
      () => setStatus.run({ id: cheque.id, status: 'bounced' })
    );
  }

  return (
    <Screen
      header={
        <ScreenHeader
          clock=""
          role={role.name}
          title="Cheques"
          subtitle={loading ? 'Loading…' : 'In hand and banked'}
          badge={pending.length ? `${pending.length} to bank` : 'All banked'}
          badgeTone={pending.length ? 'pending' : 'success'}
        />
      }
      nav={nav}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={COLORS.brand} />
      }
      footer={
        pending.length ? (
          <ActionButton
            label={`Deposit all ${pending.length} · ${rupees(pendingValue)}`}
            tone="brand"
            loading={setStatus.busy}
            onPress={() =>
              confirmAction(
                'Mark all as deposited?',
                `${pending.length} cheque(s) worth ${rupees(pendingValue)} going to the bank.`,
                async () => {
                  for (const cheque of pending) {
                    await setStatus.run({ id: cheque.id, status: 'deposited' });
                  }
                }
              )
            }
          />
        ) : null
      }
    >
      <AsyncBoundary
        loading={loading}
        error={error}
        onRetry={reload}
        empty={!cheques.length}
        emptyGlyph="🧾"
        emptyText="No cheques recorded yet."
      >
        <StatRow
          stats={[
            { label: 'To deposit', value: pending.length, tone: 'pending' },
            { label: 'Cleared', value: cleared.length, tone: 'success' },
            { label: 'Bounced', value: bounced.length, tone: 'danger' },
          ]}
        />

        {bounced.length ? (
          <NoticeBar tone="danger">
            {`${bounced[0].party} — cheque ${bounced[0].cheque_no} for ${rupees(bounced[0].amount)} returned. The balance is still outstanding.`}
          </NoticeBar>
        ) : null}

        <Card title="Cheques" flush>
          {cheques.map((cheque, index) => {
            const look = STATE[cheque.status] || STATE.deposited;
            const quiet = cheque.status === 'cleared';

            return (
              <View
                key={cheque.id}
                style={[styles.row, { backgroundColor: look.row }, index ? styles.ruled : null]}
              >
                <TouchableOpacity
                  style={styles.tapArea}
                  onPress={() => act(cheque)}
                  disabled={!look.next || setStatus.busy}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={`${cheque.party}, ${rupees(cheque.amount)}, ${look.label}`}
                >
                  <View style={styles.body}>
                    <AppText
                      weight="bold"
                      size="sm"
                      color={quiet ? COLORS.textSecondary : COLORS.text}
                      numberOfLines={1}
                    >
                      {cheque.party}
                    </AppText>
                    <AppText size="xs" color={COLORS.textSecondary} style={styles.meta}>
                      {[cheque.cheque_no, cheque.bank_name, formatDate(cheque.cheque_date)]
                        .filter(Boolean)
                        .join(' · ')}
                    </AppText>
                  </View>

                  <View style={styles.right}>
                    <AppText
                      weight="bold"
                      size="sm"
                      color={
                        cheque.status === 'bounced'
                          ? COLORS.error
                          : quiet
                            ? COLORS.textSecondary
                            : COLORS.text
                      }
                    >
                      {rupees(cheque.amount)}
                    </AppText>
                    <Badge tone={look.badge} style={styles.badge}>{look.label}</Badge>
                  </View>
                </TouchableOpacity>

                {cheque.status === 'deposited' ? (
                  <TouchableOpacity
                    onPress={() => bounce(cheque)}
                    style={styles.bounce}
                    accessibilityRole="button"
                    accessibilityLabel={`Mark ${cheque.cheque_no} bounced`}
                  >
                    <AppText weight="bold" size="xs" color={COLORS.error}>Bounced</AppText>
                  </TouchableOpacity>
                ) : null}
              </View>
            );
          })}
        </Card>
      </AsyncBoundary>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { paddingVertical: 12, paddingHorizontal: 14 },
  ruled: { borderTopWidth: 1, borderTopColor: COLORS.borderLight },
  tapArea: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  body: { flex: 1 },
  meta: { marginTop: 3 },
  right: { alignItems: 'flex-end' },
  badge: { marginTop: 5 },
  bounce: { alignSelf: 'flex-start', marginTop: 8, paddingVertical: 3 },
});
