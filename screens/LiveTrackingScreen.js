import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  StyleSheet,
  FlatList,
  ActivityIndicator,
  TouchableOpacity,
  TextInput,
  Platform,
  Pressable,
  SafeAreaView,
  AppState
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { COLORS } from '../constants/colors';
import AppText from '../components/AppText';
import api, { describeError } from '../services/api';
import { showAlert } from '../services/confirm';
import { normalizeSearch, isSearchActive } from '../utils/search';
import { formatTime, formatDate, todayString, addDays } from '../utils/datetime';
import LeafletMap from '../components/LeafletMap';

// Shared with every other screen — see utils/datetime.js for why parsing the
// server's timestamps with `new Date(value)` shifted them by the UTC offset.
const todayStr = todayString;
const fmtTime = (value) => formatTime(value, { fallback: '' });
const formatDatePretty = formatDate;

export default function LiveTrackingScreen({ initialUser }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [employees, setEmployees] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedUser, setSelectedUser] = useState(initialUser || null);
  const [trailDate, setTrailDate] = useState(todayStr());
  const [trailPoints, setTrailPoints] = useState([]);
  const [trailLoading, setTrailLoading] = useState(false);

  const loadTrackingData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get('/location/live');
      setEmployees(res.data.locations || []);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // Refreshes every 30s while the app is in front of the user, and stops when
  // it is not. Unconditional polling kept a backgrounded browser tab and a
  // pocketed phone querying the location table every half minute all day.
  useEffect(() => {
    loadTrackingData();

    let interval = null;
    const start = () => {
      if (!interval) interval = setInterval(loadTrackingData, 30000);
    };
    const stop = () => {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    };

    start();

    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        loadTrackingData();
        start();
      } else {
        stop();
      }
    });

    return () => {
      stop();
      subscription.remove();
    };
  }, [loadTrackingData]);

  useEffect(() => {
    if (initialUser && initialUser._trackId !== selectedUser?._trackId) {
      setSelectedUser(initialUser);
      setTrailDate(todayStr());
      loadTrailHistory(initialUser, todayStr());
    }
    // selectedUser is read to compare against the incoming user, not to drive
    // the effect: adding it would re-run this on every selection change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialUser]);

  async function loadTrailHistory(user, date) {
    setTrailLoading(true);
    try {
      const res = await api.get(`/location/user/${user.id}/history`, { params: { date } });
      setTrailPoints(res.data.locations || []);
    } catch (err) {
      setTrailPoints([]);
      showAlert('Tracking history unavailable', describeError(err));
    } finally {
      setTrailLoading(false);
    }
  }

  const handleOpenTrail = (user) => {
    setSelectedUser(user);
    setTrailDate(todayStr());
    loadTrailHistory(user, todayStr());
  };

  const adjustTrailDate = (amount) => {
    const newDateStr = addDays(trailDate, amount);
    setTrailDate(newDateStr);
    if (selectedUser) loadTrailHistory(selectedUser, newDateStr);
  };

  const activeCount = employees.filter(e => e.checkin_time && !e.checkout_time).length;
  const offlineCount = employees.length - activeCount;

  const filteredEmployees = useMemo(() => {
    let list = employees;
    if (isSearchActive(searchQuery)) {
      const normQuery = normalizeSearch(searchQuery);
      list = list.filter(e => normalizeSearch(e.name).includes(normQuery) || normalizeSearch(e.id).includes(normQuery));
    }
    return list;
  }, [employees, searchQuery]);

  const globalMarkers = useMemo(() => {
    return employees.filter(e => e.latitude && e.longitude).map(e => {
      const isOnline = e.checkin_time && !e.checkout_time;
      return {
        lat: e.latitude,
        lng: e.longitude,
        color: isOnline ? '#10b981' : '#ef4444',
        // Text, not markup — the map escapes it. A name is whatever an admin
        // typed into the employee form.
        title: e.name,
        subtitle: isOnline ? 'Online' : 'Offline',
      };
    });
  }, [employees]);

  const trailMarkers = useMemo(() => {
    return trailPoints.map((p, i) => ({
      lat: p.latitude,
      lng: p.longitude,
      color: i === trailPoints.length - 1 ? '#10b981' : '#3b82f6',
      title: `Point ${i + 1}`,
      subtitle: fmtTime(p.recorded_at)
    }));
  }, [trailPoints]);

  const trailLines = useMemo(() => {
    return trailPoints.map(p => ({ lat: p.latitude, lng: p.longitude }));
  }, [trailPoints]);

  if (selectedUser) {
    const isOnline = selectedUser.checkin_time && !selectedUser.checkout_time;
    return (
      <SafeAreaView style={styles.container}>
        {/* Detail Header */}
        <View style={styles.detailHeader}>
          <TouchableOpacity onPress={() => setSelectedUser(null)} style={styles.backBtn}>
            <MaterialCommunityIcons name="chevron-left" size={28} color={COLORS.text} />
          </TouchableOpacity>
          <View style={[styles.avatarMini, { backgroundColor: isOnline ? COLORS.error : COLORS.textMuted }]}>
            <AppText weight="bold" color={COLORS.white}>{selectedUser.name.charAt(0).toUpperCase()}</AppText>
          </View>
          <View style={{ flex: 1, marginLeft: 10 }}>
            <AppText weight="bold" size="md">{selectedUser.name.toUpperCase()}</AppText>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <View style={[styles.statusDot, { backgroundColor: isOnline ? COLORS.success : COLORS.textMuted }]} />
              <AppText size="xs" color={isOnline ? COLORS.success : COLORS.textMuted} style={{ marginLeft: 4 }}>
                {isOnline ? 'Active Now' : 'Offline'}
              </AppText>
            </View>
          </View>
          
          {/* Date Picker */}
          <View style={styles.datePickerBadgeWrapper}>
            <TouchableOpacity onPress={() => adjustTrailDate(-1)} style={styles.dateArrowBtn}>
                <MaterialCommunityIcons name="chevron-left" size={20} color={COLORS.text} />
            </TouchableOpacity>
            <View style={styles.datePickerBadge}>
              <MaterialCommunityIcons name="calendar-month" size={16} color={COLORS.primary} style={{ marginRight: 6 }} />
              <AppText weight="bold" color={COLORS.primary}>{trailDate === todayStr() ? 'Today' : formatDatePretty(trailDate)}</AppText>
              <MaterialCommunityIcons name="menu-down" size={20} color={COLORS.primary} />
            </View>
            <TouchableOpacity onPress={() => adjustTrailDate(1)} style={styles.dateArrowBtn} disabled={trailDate === todayStr()}>
                <MaterialCommunityIcons name="chevron-right" size={20} color={trailDate === todayStr() ? COLORS.border : COLORS.text} />
            </TouchableOpacity>
          </View>
          <View style={{ flex: 1, alignItems: 'flex-end' }}>
             <AppText size="xs" color={COLORS.primary} weight="bold" style={{ backgroundColor: 'rgba(239, 68, 68, 0.1)', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4 }}>{selectedUser.id}</AppText>
          </View>
        </View>

        {/* Trail Map */}
        <View style={styles.trailMapContainer}>
          {trailLoading ? (
            <ActivityIndicator size="large" color={COLORS.primary} style={{ marginTop: 40 }} />
          ) : (
            <LeafletMap markers={trailMarkers} polyLine={trailLines} />
          )}
        </View>

        {/* Stats Bar */}
        <View style={styles.statsBar}>
          <View style={styles.statBox}>
            <AppText weight="bold" size="xl" color={COLORS.error}>{trailPoints.length}</AppText>
            <AppText size="xs" color={COLORS.textMuted}>Points</AppText>
          </View>
          <View style={styles.statBoxBorder}>
            <AppText weight="bold" size="md" color={COLORS.text}>{fmtTime(selectedUser.checkin_time) || '--'}</AppText>
            <AppText size="xs" color={COLORS.textMuted}>Check In</AppText>
          </View>
          <View style={styles.statBox}>
            <AppText weight="bold" size="md" color={isOnline ? COLORS.success : COLORS.text}>
              {isOnline ? 'Active' : (fmtTime(selectedUser.checkout_time) || '--')}
            </AppText>
            <AppText size="xs" color={COLORS.textMuted}>Check Out</AppText>
          </View>
        </View>

        {/* Timeline */}
        <View style={styles.timelineContainer}>
          <AppText weight="bold" size="xs" color={COLORS.textMuted} style={{ marginBottom: 10 }}>LOCATION TIMELINE</AppText>
          <FlatList
            data={[...trailPoints].reverse()}
            keyExtractor={item => String(item.id)}
            renderItem={({ item, index }) => (
              <View style={styles.timelineRow}>
                <View style={styles.timelineLineContainer}>
                  <View style={[styles.timelineDot, { backgroundColor: index === 0 ? COLORS.error : COLORS.surfaceLight, borderColor: index === 0 ? COLORS.error : COLORS.textSecondary }]} />
                  {index !== trailPoints.length - 1 && <View style={styles.timelineLine} />}
                </View>
                <View style={styles.timelineContent}>
                  <AppText weight="bold" size="sm" color={index === 0 ? COLORS.error : COLORS.text}>{fmtTime(item.recorded_at)}</AppText>
                  <AppText size="xs" color={COLORS.textMuted}>{Number(item.latitude).toFixed(5)}, {Number(item.longitude).toFixed(5)}</AppText>
                </View>
              </View>
            )}
          />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      {/* Global Stats Header */}
      <View style={styles.globalHeader}>
        <View style={[styles.badge, styles.badgeActive]}>
          <View style={[styles.statusDot, { backgroundColor: COLORS.success }]} />
          <AppText size="xs" weight="bold" color={COLORS.success} style={{ marginLeft: 4 }}>{activeCount} Active</AppText>
        </View>
        <View style={[styles.badge, styles.badgeOffline]}>
          <View style={[styles.statusDot, { backgroundColor: COLORS.textMuted }]} />
          <AppText size="xs" weight="bold" color={COLORS.textMuted} style={{ marginLeft: 4 }}>{offlineCount} Offline</AppText>
        </View>
        <View style={[styles.badge, styles.badgeTotal]}>
          <View style={[styles.statusDot, { backgroundColor: COLORS.primary }]} />
          <AppText size="xs" weight="bold" color={COLORS.primary} style={{ marginLeft: 4 }}>{employees.length} Total</AppText>
        </View>
      </View>

      {/* Global Map */}
      <View style={styles.globalMapContainer}>
        {loading && !employees.length ? (
          <ActivityIndicator size="large" color={COLORS.primary} style={{ marginTop: 40 }} />
        ) : (
          <LeafletMap markers={globalMarkers} />
        )}
      </View>

      {/* Search Bar */}
      <View style={styles.searchSection}>
        <View style={styles.searchBox}>
          <MaterialCommunityIcons name="magnify" size={20} color={COLORS.textMuted} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search by name or ID..."
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholderTextColor={COLORS.textMuted}
          />
        </View>
      </View>

      {/* Employee List */}
      <FlatList
        data={filteredEmployees}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.listContent}
        renderItem={({ item }) => {
          const isOnline = item.checkin_time && !item.checkout_time;
          return (
            <TouchableOpacity style={styles.employeeCard} onPress={() => handleOpenTrail(item)}>
              <View style={[styles.avatarMini, { backgroundColor: isOnline ? COLORS.error : COLORS.textMuted }]}>
                <AppText weight="bold" color={COLORS.white} size="lg">{item.name.charAt(0).toUpperCase()}</AppText>
                {isOnline && <View style={styles.avatarOnlineBadge} />}
              </View>
              <View style={{ flex: 1, marginLeft: 16 }}>
                <AppText weight="bold" size="md">{item.name.toUpperCase()}</AppText>
                <AppText size="xs" color={COLORS.textMuted}>{item.id}</AppText>
                {isOnline && item.checkin_time && (
                  <AppText size="xs" color={COLORS.textMuted} style={{ marginTop: 2 }}>In {fmtTime(item.checkin_time)}</AppText>
                )}
              </View>
              <View style={styles.statusPillWrapper}>
                <View style={[styles.statusPill, { borderColor: isOnline ? COLORS.success : COLORS.textMuted }]}>
                  <AppText size="xs" weight="bold" color={isOnline ? COLORS.success : COLORS.textMuted}>
                    {isOnline ? 'Active' : 'Offline'}
                  </AppText>
                </View>
                <MaterialCommunityIcons name="chevron-right" size={20} color={COLORS.textMuted} style={{ marginLeft: 8 }} />
              </View>
            </TouchableOpacity>
          );
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background
  },
  globalHeader: {
    flexDirection: 'row',
    padding: 12,
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    gap: 12
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: COLORS.surfaceLight
  },
  badgeActive: { backgroundColor: 'rgba(16, 185, 129, 0.1)' },
  badgeOffline: { backgroundColor: 'rgba(100, 116, 139, 0.1)' },
  badgeTotal: { backgroundColor: 'rgba(59, 130, 246, 0.1)' },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  globalMapContainer: {
    height: 300,
    backgroundColor: '#e2e8f0'
  },
  searchSection: {
    padding: 16,
    backgroundColor: COLORS.surface
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surfaceLight,
    borderRadius: 8,
    paddingHorizontal: 12,
    height: 44
  },
  searchInput: {
    flex: 1,
    marginLeft: 8,
    fontSize: 14,
    color: COLORS.text,
    outlineStyle: 'none'
  },
  listContent: {
    padding: 16,
    paddingTop: 0,
    gap: 12
  },
  employeeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surface,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border
  },
  avatarMini: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative'
  },
  avatarOnlineBadge: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: COLORS.success,
    borderWidth: 2,
    borderColor: COLORS.surface
  },
  statusPillWrapper: {
    flexDirection: 'row',
    alignItems: 'center'
  },
  statusPill: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1
  },
  
  // Detailed View Styles
  detailHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border
  },
  backBtn: {
    marginRight: 10
  },
  datePickerBadgeWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 'auto',
    marginRight: 'auto'
  },
  dateArrowBtn: {
    padding: 4
  },
  datePickerBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.primary,
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginHorizontal: 8
  },
  trailMapContainer: {
    flex: 1,
    minHeight: 300,
    backgroundColor: '#e2e8f0'
  },
  statsBar: {
    flexDirection: 'row',
    backgroundColor: COLORS.surface,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: COLORS.border
  },
  statBox: {
    flex: 1,
    padding: 16,
    alignItems: 'center',
    justifyContent: 'center'
  },
  statBoxBorder: {
    flex: 1,
    padding: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: COLORS.border
  },
  timelineContainer: {
    flex: 1,
    backgroundColor: COLORS.surface,
    padding: 16
  },
  timelineRow: {
    flexDirection: 'row',
    marginBottom: 0
  },
  timelineLineContainer: {
    width: 20,
    alignItems: 'center'
  },
  timelineDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 2,
    zIndex: 2,
    marginTop: 4
  },
  timelineLine: {
    width: 2,
    flex: 1,
    backgroundColor: COLORS.border,
    marginTop: -4,
    marginBottom: -4,
    zIndex: 1
  },
  timelineContent: {
    flex: 1,
    paddingBottom: 20,
    marginLeft: 12
  }
});
