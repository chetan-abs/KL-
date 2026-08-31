import React from 'react';
import { View, StyleSheet } from 'react-native';

import { COLORS } from '../../constants/colors';
import { Orders } from '../../services/endpoints';
import { useApi, useAction } from '../../hooks/useApi';
import { rupees, qtyWithUnit } from '../../utils/format';
import { showAlert, confirmAction, promptText } from '../../services/confirm';
import AppText from '../../components/AppText';
import Screen from '../../components/mobile/Screen';
import ScreenHeader from '../../components/mobile/ScreenHeader';
import Card from '../../components/mobile/Card';
import DetailRow from '../../components/mobile/DetailRow';
import Badge from '../../components/mobile/Badge';
import ActionButton from '../../components/mobile/ActionButton';
import NoticeBar from '../../components/mobile/NoticeBar';
import AsyncBoundary from '../../components/mobile/AsyncBoundary';

/**
 * 03 — Manas approves. Full detail before the decision; three ways out.
 *
 * Reject and Approve share a row and Modify sits under them, which is the
 * mockup's arrangement and the right one: the two irreversible verbs are
 * weighted equally so neither is the default, and the escape hatch — change it
 * first, then approve — gets its own line rather than competing with them.
 *
 * The footer is pinned by `Screen`, so the outstanding balance and the Approve
 * button are never on screen at different times.
 *
 * A rejection needs a reason: the server refuses without one, because a
 * rejection the salesman cannot explain to the party is not much use.
 */
const OVERDUE_DAYS = 45;

export default function OrderReviewScreen({ role, order: seed, onBack, onSettled, nav }) {
  const orderId = seed?.order_id;
  const { data, loading, error, reload } = useApi(() => Orders.get(orderId), [orderId]);
  const order = data?.order;

  const approve = useAction(() => Orders.approve(orderId), {
    onDone: () => {
      showAlert('Approved', `${order.customer_name} — sent to picking.`);
      onSettled?.();
    },
    onFail: (message) => showAlert('Could not approve', message),
  });

  const reject = useAction((reason) => Orders.reject(orderId, reason), {
    onDone: () => {
      showAlert('Rejected', 'The salesman has been notified.');
      onSettled?.();
    },
    onFail: (message) => showAlert('Could not reject', message),
  });

  const credit = order ? Number(order.credit_limit) - Number(order.outstanding) : 0;
  const overdue = Number(order?.outstanding_days) >= OVERDUE_DAYS;
  const overLimit = order ? Number(order.total_amount) > credit : false;

  function confirmApprove() {
    confirmAction(
      'Approve this order?',
      `${order.customer_name} — ${rupees(order.total_amount)}. It moves to picking.${
        overLimit ? ' This is over their available credit.' : ''
      }`,
      approve.run
    );
  }

  function confirmReject() {
    promptText({
      title: 'Reject this order?',
      message: `${order.customer_name} will be told it was not accepted. Give a reason.`,
      placeholder: 'e.g. 62 day outstanding',
      confirmLabel: 'Reject',
      destructive: true,
      onSubmit: (reason) => reject.run(reason),
    });
  }

  return (
    <Screen
      nav={nav}
      header={
        <ScreenHeader
          clock={order ? `#${order.order_id}` : ''}
          role={role.name}
          title="SO Review"
          subtitle={order?.customer_name || seed?.customer_name}
          onBack={onBack}
          backLabel="Queue"
          badge={order?.status || 'Pending'}
          badgeTone="pending"
        />
      }
      footer={
        order ? (
          <>
            <View style={styles.pair}>
              <ActionButton
                label="✗  Reject"
                tone="reject"
                loading={reject.busy}
                onPress={confirmReject}
                style={styles.half}
              />
              <ActionButton
                label="✓  Approve"
                tone="approve"
                loading={approve.busy}
                onPress={confirmApprove}
                style={styles.half}
              />
            </View>
            <ActionButton
              label="✎  Modify before approve"
              tone="neutral"
              onPress={() =>
                showAlert('Modify', 'Rates come from the item master and are not editable here. Quantities are changed by the salesman on the order window.')
              }
            />
          </>
        ) : null
      }
    >
      <AsyncBoundary loading={loading} error={error} onRetry={reload}>
        {order ? (
          <>
            <Card title="Party info" flush>
              <DetailRow label="Party" value={order.customer_name} tone="brand" />
              <DetailRow
                label="Type"
                value={[order.customer_group, order.customer_city, order.salesman_name]
                  .filter(Boolean)
                  .join(' · ')}
              />
              <DetailRow
                label="Outstanding"
                value={`${rupees(order.outstanding)}${
                  order.outstanding_days ? ` · ${order.outstanding_days}d` : ''
                }${overdue ? ' ⚠' : ''}`}
                tone={overdue ? 'warning' : 'default'}
              />
              <DetailRow
                label="Credit Available"
                value={rupees(credit)}
                tone={credit > 0 ? 'success' : 'danger'}
                last
              />
            </Card>

            {overdue ? (
              <NoticeBar tone="warning">
                {`${order.customer_name} — ${order.outstanding_days} day outstanding. Review before approving.`}
              </NoticeBar>
            ) : null}

            {overLimit ? (
              <NoticeBar tone="danger">
                {`This order is ${rupees(Number(order.total_amount) - credit)} over their available credit.`}
              </NoticeBar>
            ) : null}

            <Card title={`Items (${order.items?.length || 0})`} flush>
              {(order.items || []).map((item, index) => (
                <View key={item.id} style={[styles.item, index ? styles.ruled : null]}>
                  <View style={styles.itemBody}>
                    <AppText weight="bold" size="sm">{item.item_name}</AppText>
                    <AppText size="xs" color={COLORS.textSecondary} style={styles.itemMeta}>
                      {`${rupees(item.rate)} × ${qtyWithUnit(item.qty)}${
                        Number(item.discount) ? ` · ${item.discount}% off` : ''
                      }`}
                    </AppText>
                  </View>
                  <Badge tone="success">{rupees(item.total)}</Badge>
                </View>
              ))}
            </Card>

            <Card flush>
              <DetailRow label="Order value" value={rupees(order.total_amount)} tone="brand" />
              <DetailRow label="Placed" value={order.order_date} />
              {order.notes ? (
                <DetailRow label="Instructions" value={order.notes} tone="warning" last />
              ) : null}
            </Card>
          </>
        ) : null}
      </AsyncBoundary>
    </Screen>
  );
}

const styles = StyleSheet.create({
  pair: { flexDirection: 'row', gap: 10 },
  half: { flex: 1 },
  item: { flexDirection: 'row', alignItems: 'center', paddingVertical: 13, paddingHorizontal: 16 },
  ruled: { borderTopWidth: 1, borderTopColor: COLORS.borderLight },
  itemBody: { flex: 1, paddingRight: 10 },
  itemMeta: { marginTop: 3 },
});
