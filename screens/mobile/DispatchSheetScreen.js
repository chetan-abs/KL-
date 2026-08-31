import React from 'react';
import { View, TouchableOpacity, RefreshControl, StyleSheet } from 'react-native';

import { COLORS } from '../../constants/colors';
import { Dispatch, Orders, Users } from '../../services/endpoints';
import { useApi, useAction } from '../../hooks/useApi';
import { businessDate } from '../../utils/datetime';
import { confirmAction, showAlert } from '../../services/confirm';
import AppText from '../../components/AppText';
import Screen from '../../components/mobile/Screen';
import ScreenHeader from '../../components/mobile/ScreenHeader';
import Card from '../../components/mobile/Card';
import DetailRow from '../../components/mobile/DetailRow';
import Select from '../../components/mobile/Select';
import Avatar from '../../components/mobile/Avatar';
import Badge from '../../components/mobile/Badge';
import ActionButton from '../../components/mobile/ActionButton';
import NoticeBar from '../../components/mobile/NoticeBar';
import AsyncBoundary from '../../components/mobile/AsyncBoundary';

/**
 * 10 — Ajit builds the dispatch sheet. Ajit only (R03).
 *
 * The sequence discs are numbered by *delivery* order while the amber strip says
 * the auto is loaded in reverse — last drop at the bottom of the pile, so the
 * first drop comes off the tailgate first. Showing the load order instead would
 * match the physical act but not the driver's run sheet, and the driver reads
 * this list far more often than the loader does.
 *
 * Only invoiced orders can be loaded: goods leave the building once they are
 * billed, and the server refuses anything earlier.
 */
const SEQ_COLORS = [COLORS.actionReject, COLORS.accent, COLORS.brand, COLORS.actionTeal];

const ordinal = (n) => `${n}${['st', 'nd', 'rd'][n - 1] || 'th'}`;

export default function DispatchSheetScreen({ role, nav }) {
  const sheets = useApi(() => Dispatch.sheets(), []);
  // Orders at `invoiced`, not the billing queue: a dispatcher needs to know what
  // is ready to load, and reading the invoice list would need `billing.view` —
  // a grant Ajit has no business holding just to load an auto.
  const billed = useApi(() => Orders.list({ status: 'invoiced' }), []);
  const staff = useApi(() => Users.list(), []);

  const [driverId, setDriverId] = React.useState(null);
  const [sheetIndex, setSheetIndex] = React.useState(0);

  const all = sheets.data?.sheets || [];
  const sheet = all[sheetIndex] || null;

  // Anything invoiced and not already on a sheet. The server enforces both, but
  // offering an order that will be refused is a tap wasted in a loading bay.
  const loadable = (billed.data?.orders || []).filter(
    (order) => !all.some((s) => (s.stops || []).some((stop) => stop.order_id === order.order_id))
  );

  const reload = () => {
    sheets.reload();
    billed.reload();
  };

  const openSheet = useAction(
    () => Dispatch.openSheet({ driver_id: driverId, zone: 'S+C GHY', departure_time: '10:30' }),
    {
      onDone: () => {
        showAlert('Sheet opened', 'Add the orders that go on this run.');
        reload();
      },
      onFail: (message) => showAlert('Could not open a sheet', message),
    }
  );

  const addStop = useAction((orderId) => Dispatch.addStop(sheet.id, { order_id: orderId, cartons: 1 }), {
    onDone: reload,
    onFail: (message) => showAlert('Could not add that order', message),
  });

  const release = useAction(() => Dispatch.release(sheet.id), {
    onDone: (result) => {
      showAlert('Released', `${result.stops} stop(s) sent to ${sheet.driver_name}.`);
      reload();
    },
    onFail: (message) => showAlert('Could not release', message),
  });

  const drivers = (staff.data?.employees || [])
    .filter((u) => u.is_active)
    .map((u) => ({ value: u.id, label: `${u.name} (${u.id})` }));

  const stops = sheet?.stops || [];
  const building = sheet?.status === 'building';

  return (
    <Screen
      header={
        <ScreenHeader
          clock={businessDate()}
          role={role.name}
          title="Dispatch Sheet"
          subtitle={sheet ? `${sheet.driver_name} · ${sheet.zone || 'route'}` : 'No sheet open'}
          badge={sheet ? sheet.status : 'New'}
          badgeTone={building ? 'pending' : sheet ? 'success' : 'onBrand'}
        />
      }
      nav={nav}
      refreshControl={
        <RefreshControl refreshing={sheets.refreshing} onRefresh={sheets.refresh} tintColor={COLORS.brand} />
      }
      footer={
        sheet && building ? (
          <View style={styles.pair}>
            {all.length > 1 ? (
              <ActionButton
                label="Next route  →"
                tone="neutral"
                onPress={() => setSheetIndex((i) => (i + 1) % all.length)}
                style={styles.half}
              />
            ) : null}
            <ActionButton
              label="Sign + Release  →"
              tone="brand"
              loading={release.busy}
              loadingLabel="Releasing"
              disabled={!stops.length}
              onPress={() =>
                confirmAction(
                  'Sign and release this sheet?',
                  `${stops.length} orders to ${sheet.driver_name}. The driver's route opens once released.`,
                  release.run
                )
              }
              style={styles.half}
            />
          </View>
        ) : null
      }
    >
      <AsyncBoundary loading={sheets.loading} error={sheets.error} onRetry={reload}>
        {!sheet ? (
          <Card title="Open a sheet">
            <AppText size="sm" color={COLORS.textSecondary} style={styles.intro}>
              A driver has one sheet per day. Pick who is driving this run.
            </AppText>
            <Select
              label="Driver"
              required
              value={driverId}
              options={drivers}
              onChange={setDriverId}
              placeholder="Choose a driver"
              style={styles.spaced}
            />
            <ActionButton
              label="Open sheet"
              tone="brand"
              disabled={!driverId}
              loading={openSheet.busy}
              onPress={openSheet.run}
              style={styles.spaced}
            />
          </Card>
        ) : (
          <>
            <NoticeBar tone="warning">
              Load REVERSE — last delivery loads FIRST on the auto.
            </NoticeBar>

            <Card title={`${sheet.driver_name} — ${sheet.zone || 'route'} (${stops.length})`} flush>
              {stops.length ? (
                stops.map((stop, index) => (
                  <View key={stop.id} style={[styles.row, index ? styles.ruled : null]}>
                    <Avatar
                      label={ordinal(stop.seq)}
                      color={SEQ_COLORS[index % SEQ_COLORS.length]}
                      size={38}
                    />
                    <View style={styles.body}>
                      <View style={styles.titleRow}>
                        <AppText weight="bold" size="sm" numberOfLines={1} style={styles.flex}>
                          {stop.party}
                        </AppText>
                        {stop.is_urgent ? (
                          <AppText weight="bold" size="xs" color={COLORS.error}>⚡ URGENT</AppText>
                        ) : null}
                      </View>
                      <AppText size="xs" color={COLORS.textSecondary} style={styles.meta}>
                        {`#${stop.order_id} · ${stop.cartons} carton${stop.cartons > 1 ? 's' : ''}${
                          stop.area ? ` · ${stop.area}` : ''
                        }`}
                      </AppText>
                    </View>
                    <Badge tone={stop.state === 'done' ? 'success' : 'neutral'}>{stop.state}</Badge>
                  </View>
                ))
              ) : (
                <View style={styles.empty}>
                  <AppText size="sm" color={COLORS.textMuted}>
                    No orders on this sheet yet.
                  </AppText>
                </View>
              )}
            </Card>

            {building ? (
              <Card title={`Ready to load (${loadable.length})`} flush>
                {loadable.length ? (
                  loadable.map((order, index) => (
                    <TouchableOpacity
                      key={order.order_id}
                      style={[styles.row, index ? styles.ruled : null]}
                      onPress={() => addStop.run(order.order_id)}
                      disabled={addStop.busy}
                      accessibilityRole="button"
                      accessibilityLabel={`Add ${order.customer_name} to the sheet`}
                    >
                      <Avatar name={order.customer_name} size={34} />
                      <View style={styles.body}>
                        <AppText weight="bold" size="sm" numberOfLines={1}>
                          {order.customer_name}
                        </AppText>
                        <AppText size="xs" color={COLORS.textSecondary} style={styles.meta}>
                          {`#${order.order_id} · ${order.customer_city || 'no area'}`}
                        </AppText>
                      </View>
                      <AppText weight="bold" size="sm" color={COLORS.primary}>+ Add</AppText>
                    </TouchableOpacity>
                  ))
                ) : (
                  <View style={styles.empty}>
                    <AppText size="sm" color={COLORS.textMuted}>
                      Nothing invoiced and waiting. Gaurav bills before goods can load.
                    </AppText>
                  </View>
                )}
              </Card>
            ) : null}

            <Card flush>
              <DetailRow label="Total orders" value={String(stops.length)} tone="brand" />
              <DetailRow label="Departure" value={sheet.departure_time || '—'} tone="danger" last />
            </Card>
          </>
        )}
      </AsyncBoundary>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  pair: { flexDirection: 'row', gap: 10 },
  half: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 13, paddingHorizontal: 14 },
  ruled: { borderTopWidth: 1, borderTopColor: COLORS.borderLight },
  body: { flex: 1, paddingHorizontal: 11 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  meta: { marginTop: 3 },
  empty: { padding: 20, alignItems: 'center' },
  intro: { lineHeight: 19 },
  spaced: { marginTop: 13 },
});
