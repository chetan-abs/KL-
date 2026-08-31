import React from 'react';
import {
  View,
  ScrollView,
  StyleSheet,
  ActivityIndicator
} from 'react-native';
import { COLORS } from '../constants/colors';
import AppText from '../components/AppText';
import Notice from '../components/Notice';
import { useAuth } from '../context/AuthContext';
import api, { describeError } from '../services/api';

// Every stat here is read off a DECIMAL column, and DECIMAL crosses the wire as
// a string unless the route coerces it. Normalising the whole payload on arrival
// keeps the render path free of `.toFixed` on a string — which throws, and with
// no error boundary above this screen takes the app down with it. A missing or
// half-populated response lands on the same zeroes as the initial state.
const toNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const normalizeStats = (data) => ({
  // 'self' or 'company' — the server scopes the figures to the caller unless
  // they hold the orders area grant, and says which it did.
  scope: data?.scope === 'company' ? 'company' : 'self',
  today: {
    ordersTaken: toNumber(data?.today?.ordersTaken),
    ordersValue: toNumber(data?.today?.ordersValue),
    noOrders: toNumber(data?.today?.noOrders),
    itemsSold: toNumber(data?.today?.itemsSold)
  },
  monthly: {
    itemsSold: toNumber(data?.monthly?.itemsSold),
    totalSalesValue: toNumber(data?.monthly?.totalSalesValue),
    totalShopsVisited: toNumber(data?.monthly?.totalShopsVisited),
    totalVisits: toNumber(data?.monthly?.totalVisits)
  }
});

const EMPTY_STATS = normalizeStats(null);

export default function HomeScreen() {
  const { user } = useAuth();

  const [loadingStats, setLoadingStats] = React.useState(true);
  const [error, setError] = React.useState('');
  const [stats, setStats] = React.useState(EMPTY_STATS);

  // Checking in and out lives in the navbar's shift menu and in the check-in
  // gate. This screen used to carry a third copy of that logic behind a card
  // that had been removed from the layout — state, handlers, styles and all.
  const loadDashboard = React.useCallback(async () => {
    setLoadingStats(true);
    setError('');
    try {
      const { data } = await api.get('/reports/dashboard');
      setStats(normalizeStats(data));
    } catch (err) {
      setError(describeError(err));
      setStats(EMPTY_STATS);
    } finally {
      setLoadingStats(false);
    }
  }, []);

  React.useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <AppText weight="bold" size="lg" color={COLORS.text} style={{ marginBottom: 20 }}>
          Hi, {user?.name?.split(' ')[0] || 'User'}
        </AppText>

        <View style={styles.sectionHead}>
          <AppText weight="bold" size="lg" color={COLORS.text}>
            Today's Performance
          </AppText>
          <AppText size="xs" color={COLORS.textMuted}>
            {stats.scope === 'company' ? 'Whole company' : 'Your own figures'}
          </AppText>
        </View>

        {error ? (
          <Notice tone="error" style={{ marginBottom: 16 }}>{error}</Notice>
        ) : null}

        {loadingStats ? (
          <ActivityIndicator size="large" color={COLORS.primary} style={{ marginTop: 40 }} />
        ) : (
          <View style={styles.statsGrid}>
            <View style={[styles.statTile, { borderLeftColor: COLORS.primary, borderLeftWidth: 4 }]}>
              <AppText size="xs" color={COLORS.textSecondary}>ORDERS TAKEN</AppText>
              <AppText weight="bold" size="xl" color={COLORS.text}>{stats.today.ordersTaken}</AppText>
              <AppText size="xs" color={COLORS.primary} weight="bold">+ ₹{stats.today.ordersValue.toFixed(0)}</AppText>
            </View>
            <View style={[styles.statTile, { borderLeftColor: COLORS.secondary, borderLeftWidth: 4 }]}>
              <AppText size="xs" color={COLORS.textSecondary}>ITEMS SOLD</AppText>
              <AppText weight="bold" size="xl" color={COLORS.text}>{stats.today.itemsSold}</AppText>
              <AppText size="xs" color={COLORS.textMuted}>Across all shops</AppText>
            </View>
            <View style={[styles.statTile, { borderLeftColor: COLORS.error, borderLeftWidth: 4 }]}>
              <AppText size="xs" color={COLORS.textSecondary}>NO ORDERS</AppText>
              <AppText weight="bold" size="xl" color={COLORS.text}>{stats.today.noOrders}</AppText>
              <AppText size="xs" color={COLORS.textMuted}>Unproductive visits</AppText>
            </View>
            <View style={[styles.statTile, { borderLeftColor: COLORS.accent, borderLeftWidth: 4 }]}>
              <AppText size="xs" color={COLORS.textSecondary}>MTD SALES</AppText>
              <AppText weight="bold" size="xl" color={COLORS.text}>
                ₹{stats.monthly.totalSalesValue > 1000
                  ? (stats.monthly.totalSalesValue / 1000).toFixed(1) + 'k'
                  : stats.monthly.totalSalesValue.toFixed(0)}
              </AppText>
              <AppText size="xs" color={COLORS.textMuted}>Total this month</AppText>
            </View>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  scrollContent: { padding: 16, paddingBottom: 40 },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: 16
  },
  statTile: {
    width: '47%',
    backgroundColor: COLORS.surface,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
    shadowColor: COLORS.black,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.02,
    shadowRadius: 8,
    elevation: 2
  }
});
