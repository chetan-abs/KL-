import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  StyleSheet,
  FlatList,
  ActivityIndicator,
  TouchableOpacity,
  Modal,
  TextInput,
  Linking,
  ScrollView,
  Platform,
  Pressable,
  useWindowDimensions
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { COLORS } from '../constants/colors';
import AppText from '../components/AppText';
import Button from '../components/Button';
import api, { describeError } from '../services/api';
import { confirmAction, showAlert } from '../services/confirm';
import { normalizeSearch, isSearchActive } from '../utils/search';
import { formatTime, formatDate, todayString, addDays, dayOfWeek, shiftHours } from '../utils/datetime';

// Dates and times come from utils/datetime.js, which reads the server's
// DATETIME strings as the UTC they are. Parsing them with `new Date(value)`
// treated them as local time, so every check-in on this screen was displayed
// 5 hours 30 minutes early — a 10:58 AM start read as 05:28 AM.
const todayStr = todayString;
const fmtTime = formatTime;
const formatDatePretty = formatDate;

// DECIMAL columns cross the wire as strings so no precision is lost in the
// driver. `lat?.toFixed(5)` did not protect against that — optional chaining
// stops at null, not at a string that has no toFixed — so it threw.
const fmtCoord = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(5) : '—';
};

const getAvatarColor = (name) => {
  if (!name) return COLORS.primary;
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash % 360);
  return `hsl(${h}, 55%, 38%)`;
};

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

// Below this the date navigation and the search field stop sharing a row. The
// date label runs to roughly "13 August 2026" plus two arrow buttons, which
// leaves a phone-width screen nothing usable for the search input.
const SINGLE_ROW_MIN_WIDTH = 640;

export default function AttendanceScreen({ onNavigate, onTrackUser }) {
  const { width } = useWindowDimensions();
  const wideLayout = width >= SINGLE_ROW_MIN_WIDTH;

  // Navigation tabs: 'daily' | 'monthly' | 'calendar'
  const [activeTab, setActiveTab] = useState('daily');
  
  // Tab-specific filters & dates
  const [selectedDate, setSelectedDate] = useState(todayStr());
  const [selectedMonth, setSelectedMonth] = useState(new Date()); // Date object
  
  // Global Data states
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [dailyRows, setDailyRows] = useState([]);
  const [monthlySummaryRows, setMonthlySummaryRows] = useState([]);
  const [holidaysList, setHolidaysList] = useState([]);
  const [workingDays, setWorkingDays] = useState(0);
  
  // Detail Modal states
  const [selectedDailyDetail, setSelectedDailyDetail] = useState(null); // Employee daily checkin details
  const [selectedMonthlyDetail, setSelectedMonthlyDetail] = useState(null); // Employee monthly grid detail
  const [monthlyDetailRows, setMonthlyDetailRows] = useState([]);
  const [monthlyDetailLoading, setMonthlyDetailLoading] = useState(false);
  
  // Holiday Management states
  const [holidayForm, setHolidayForm] = useState(null); // { dateStr, name, existingHoliday }
  const [holidaySaving, setHolidaySaving] = useState(false);
  
  // Search & Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [dailyFilter, setDailyFilter] = useState('all'); // 'all' | 'present' | 'absent'

  const selectedMonthStr = useMemo(() => {
    return `${selectedMonth.getFullYear()}-${String(selectedMonth.getMonth() + 1).padStart(2, '0')}`;
  }, [selectedMonth]);

  // Loaders
  const loadData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      if (activeTab === 'daily') {
        const res = await api.get('/attendance/daily', { params: { date: selectedDate } });
        setDailyRows(res.data.attendance || []);
      } else if (activeTab === 'monthly') {
        const year = selectedMonth.getFullYear();
        const month = selectedMonth.getMonth() + 1;
        const res = await api.get('/attendance/monthly-summary', { params: { year, month } });
        setMonthlySummaryRows(res.data.employees || []);
        setWorkingDays(res.data.workingDays || 0);
      } else if (activeTab === 'calendar') {
        const year = selectedMonth.getFullYear();
        const res = await api.get('/attendance/holidays', { params: { year } });
        setHolidaysList(res.data.holidays || []);
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [activeTab, selectedDate, selectedMonth]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Fetch employee monthly detailed log (day-by-day)
  const loadEmployeeMonthlyDetail = async (employee) => {
    setMonthlyDetailLoading(true);
    try {
      const year = selectedMonth.getFullYear();
      const month = selectedMonth.getMonth() + 1;
      const res = await api.get(`/attendance/employee/${employee.id}/monthly`, { params: { year, month } });
      
      // We map the raw response into a day-by-day status matrix
      const numDays = new Date(year, month, 0).getDate();
      const attendance = res.data.attendance || [];
      const holidays = res.data.holidays || [];
      const holidayMap = new Map(holidays.map(h => [h.holiday_date.slice(0, 10), h.name]));
      
      const dayMatrix = [];
      const todayOnlyDateStr = todayString();
      
      for (let day = 1; day <= numDays; day++) {
        const dStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const weekday = dayOfWeek(dStr);
        const isSunday = weekday === 0;
        const checkin = attendance.find(a => a.checkin_date.slice(0, 10) === dStr);
        const holidayName = holidayMap.get(dStr);
        const isFuture = dStr > todayOnlyDateStr;
        
        let status = 'absent';
        let label = 'Absent';
        if (checkin) {
          status = 'present';
          label = 'Present';
        } else if (isFuture) {
          status = 'future';
          label = 'Upcoming';
        } else if (holidayName) {
          status = 'holiday';
          label = holidayName;
        } else if (isSunday) {
          status = 'holiday';
          label = 'Weekly Off';
        }
        
        dayMatrix.push({
          date: dStr,
          dayNum: String(day).padStart(2, '0'),
          dayName: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][weekday],
          status,
          label,
          checkin_time: checkin ? checkin.checkin_time : null,
          checkout_time: checkin ? checkin.checkout_time : null,
        });
      }
      
      setMonthlyDetailRows(dayMatrix.reverse()); // Show latest days first
      setSelectedMonthlyDetail(employee);
    } catch (err) {
      showAlert('Error', describeError(err));
    } finally {
      setMonthlyDetailLoading(false);
    }
  };

  // Create Holiday handler
  const handleSaveHoliday = async () => {
    if (!holidayForm || !holidayForm.name.trim()) return;
    setHolidaySaving(true);
    try {
      await api.post('/attendance/holidays', {
        date: holidayForm.dateStr,
        name: holidayForm.name.trim()
      });
      setHolidayForm(null);
      loadData();
    } catch (err) {
      showAlert('Could not save holiday', describeError(err));
    } finally {
      setHolidaySaving(false);
    }
  };

  // Delete Holiday handler
  const handleDeleteHoliday = (holidayId) => {
    confirmAction(
      'Remove Holiday',
      'Are you sure you want to cancel this custom holiday?',
      async () => {
        try {
          await api.delete(`/attendance/holidays/${holidayId}`);
          setHolidayForm(null);
          loadData();
        } catch (err) {
          showAlert('Failed to remove holiday', describeError(err));
        }
      }
    );
  };

  // Filtered List computations
  const filteredEmployees = useMemo(() => {
    let list = activeTab === 'daily' ? dailyRows : monthlySummaryRows;
    
    if (isSearchActive(searchQuery)) {
      const normQuery = normalizeSearch(searchQuery);
      list = list.filter(emp =>
        normalizeSearch(emp.name).includes(normQuery) ||
        normalizeSearch(emp.id).includes(normQuery)
      );
    }
    
    if (activeTab === 'daily' && dailyFilter !== 'all') {
      const showPresent = dailyFilter === 'present';
      list = list.filter(emp => !!emp.checkin_time === showPresent);
    }
    
    return list;
  }, [activeTab, dailyRows, monthlySummaryRows, searchQuery, dailyFilter]);

  // Daily statistics counters
  const dailyStats = useMemo(() => {
    const total = dailyRows.length;
    const present = dailyRows.filter(r => r.checkin_time).length;
    const absent = total - present;
    return { total, present, absent };
  }, [dailyRows]);

  // Date Navigation handlers
  const adjustDay = (amount) => {
    // Calendar arithmetic on the string. Going via UTC midnight and reading it
    // back with local getters slips a day west of Greenwich.
    setSelectedDate(addDays(selectedDate, amount));
  };

  const adjustMonth = (amount) => {
    const d = new Date(selectedMonth);
    d.setMonth(d.getMonth() + amount);
    
    // Monthly stats check: don't allow navigating past today's month
    if (activeTab === 'monthly') {
      const today = new Date();
      if (d.getFullYear() > today.getFullYear() || 
         (d.getFullYear() === today.getFullYear() && d.getMonth() > today.getMonth())) {
        return;
      }
    }
    setSelectedMonth(d);
  };

  // Calendar Grid helper
  const calendarCells = useMemo(() => {
    const year = selectedMonth.getFullYear();
    const month = selectedMonth.getMonth(); // 0-indexed
    const startDayOfWeek = new Date(year, month, 1).getDay();
    const totalDays = new Date(year, month + 1, 0).getDate();
    
    const cells = [];
    // Padding blanks
    for (let i = 0; i < startDayOfWeek; i++) {
      cells.push({ blank: true, day: null, dateStr: '' });
    }
    // Days
    for (let day = 1; day <= totalDays; day++) {
      const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      cells.push({ blank: false, day, dateStr });
    }
    return cells;
  }, [selectedMonth]);

  const holidayByDate = useMemo(() => {
    const map = new Map();
    holidaysList.forEach(h => {
      map.set(h.holiday_date.slice(0, 10), h);
    });
    return map;
  }, [holidaysList]);

  // Open calendar day handler
  const handleCalendarDayPress = (cell) => {
    if (cell.blank) return;
    const dateStr = cell.dateStr;
    const isSunday = dayOfWeek(dateStr) === 0;
    
    if (isSunday) {
      showAlert('Weekly Off', `${formatDatePretty(dateStr)} is Sunday, a regular weekly off.`);
      return;
    }
    
    const existing = holidayByDate.get(dateStr);
    setHolidayForm({
      dateStr,
      name: existing ? existing.name : '',
      existingHoliday: existing || null
    });
  };

  // Rendering Helper Components
  const renderDailyItem = ({ item }) => {
    const isPresent = !!item.checkin_time;
    const initials = item.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();

    return (
      <TouchableOpacity 
        style={[styles.employeeCard, !item.is_active && { opacity: 0.5 }]} 
        onPress={() => {
          if (item.checkin_time) {
            if (onNavigate && onTrackUser) {
              onTrackUser({ ...item, _trackId: Date.now() });
              onNavigate('liveTracking');
            } else {
              setSelectedDailyDetail(item);
            }
          }
        }}
        activeOpacity={item.checkin_time ? 0.7 : 1}
      >
        <View style={[styles.avatar, { backgroundColor: getAvatarColor(item.name) }]}>
          <AppText weight="bold" color={COLORS.white} size="sm">{initials}</AppText>
        </View>
        
        <View style={styles.employeeInfo}>
          <AppText weight="bold" size="sm" color={COLORS.text}>{item.name}</AppText>
          <AppText size="xs" color={COLORS.textMuted}>ID: {item.id}</AppText>
          
          {isPresent && (
            <View style={styles.timesRow}>
              <AppText size="xs" color={COLORS.textSecondary}>
                In {fmtTime(item.checkin_time)}
              </AppText>
              {item.checkout_time ? (
                <AppText size="xs" color={COLORS.textSecondary}>
                  {' '}/ Out {fmtTime(item.checkout_time)}
                </AppText>
              ) : (
                <View style={styles.pulseContainer}>
                  <AppText size="xs" color={COLORS.success} weight="bold">{' '}• Active</AppText>
                  <View style={styles.pulseIndicator} />
                </View>
              )}
            </View>
          )}
        </View>

        <View style={[styles.statusBadge, { backgroundColor: isPresent ? COLORS.successLight : COLORS.errorLight }]}>
          <AppText size="xs" weight="bold" color={isPresent ? COLORS.success : COLORS.error}>
            {isPresent ? 'Present' : 'Absent'}
          </AppText>
        </View>
        
        {isPresent && (
          <View style={styles.arrowWrap}>
            <MaterialCommunityIcons name="chevron-right" size={20} color={COLORS.textMuted} />
          </View>
        )}
      </TouchableOpacity>
    );
  };

  const renderMonthlyItem = ({ item }) => {
    const initials = item.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();

    return (
      <TouchableOpacity 
        style={[styles.employeeCard, !item.is_active && { opacity: 0.5 }]} 
        onPress={() => loadEmployeeMonthlyDetail(item)}
        activeOpacity={0.7}
      >
        <View style={[styles.avatar, { backgroundColor: COLORS.primary }]}>
          <AppText weight="bold" color={COLORS.white} size="sm">{initials}</AppText>
        </View>
        
        <View style={styles.employeeInfo}>
          <AppText weight="bold" size="sm" color={COLORS.text}>{item.name}</AppText>
          <AppText size="xs" color={COLORS.textMuted}>ID: {item.id}</AppText>
        </View>

        <View style={styles.monthStatsRow}>
          <View style={styles.monthStatCountItem}>
            <AppText weight="bold" size="md" color={COLORS.success}>{item.present_days || 0}</AppText>
            <AppText size="xs" color={COLORS.textMuted}>Present</AppText>
          </View>
          <View style={styles.monthStatCountItem}>
            <AppText weight="bold" size="md" color={COLORS.error}>{item.absent_days || 0}</AppText>
            <AppText size="xs" color={COLORS.textMuted}>Absent</AppText>
          </View>
        </View>
        
        <View style={styles.arrowWrap}>
          <MaterialCommunityIcons name="chevron-right" size={20} color={COLORS.textMuted} />
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>

      {/* Premium Tabs */}
      <View style={styles.tabsContainer}>
        {[
          { key: 'daily', label: 'Daily', icon: 'clipboard-text-outline' },
          { key: 'monthly', label: 'Monthly Summary', icon: 'calendar-month-outline' },
          { key: 'calendar', label: 'Holidays', icon: 'calendar-star' }
        ].map(t => (
          <TouchableOpacity 
            key={t.key} 
            style={[styles.tabButton, activeTab === t.key && styles.tabButtonActive]}
            onPress={() => {
              setActiveTab(t.key);
              setSearchQuery('');
            }}
          >
            <MaterialCommunityIcons 
              name={t.icon} 
              size={18} 
              color={activeTab === t.key ? COLORS.primary : COLORS.textMuted} 
            />
            <AppText 
              weight="bold" 
              size="xs" 
              color={activeTab === t.key ? COLORS.primary : COLORS.textMuted}
              style={{ marginLeft: 6 }}
            >
              {t.label}
            </AppText>
          </TouchableOpacity>
        ))}
      </View>

      {/* Date navigation, search and refresh — one row.
          It sits outside the loading/error branches below so the date can still
          be changed while a slow day is loading, or after a failed load. */}
      <View style={[styles.filterBar, !wideLayout && styles.filterBarStacked]}>
        {activeTab === 'calendar' ? (
          <View style={{ flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 14, alignItems: 'center' }}>
            {[
              { label: 'Today', color: '#E8F9EE', border: COLORS.success },
              { label: 'Holiday', color: '#FFF8E1', border: COLORS.warning },
              { label: 'Sunday', color: '#FFEBEE', border: '#EF9A9A' },
              { label: 'Custom', color: COLORS.primaryLight, border: COLORS.primary }
            ].map(item => (
              <View key={item.label} style={styles.legendItem}>
                <View style={[styles.legendDot, { backgroundColor: item.color, borderColor: item.border }]} />
                <AppText size="xs" color={COLORS.textSecondary}>{item.label}</AppText>
              </View>
            ))}
          </View>
        ) : (
          <View style={styles.searchContainer}>
            <MaterialCommunityIcons name="magnify" size={20} color={COLORS.textMuted} style={styles.searchIcon} />
            <TextInput
              style={styles.searchInput}
              placeholder="Search by Employee ID or Name"
              placeholderTextColor={COLORS.textMuted}
              value={searchQuery}
              onChangeText={setSearchQuery}
            />
            {searchQuery.length > 0 && (
              <TouchableOpacity onPress={() => setSearchQuery('')}>
                <MaterialCommunityIcons name="close-circle" size={16} color={COLORS.textMuted} />
              </TouchableOpacity>
            )}
          </View>
        )}

        <View style={styles.periodNav}>
          <TouchableOpacity
            style={styles.periodArrow}
            onPress={() => activeTab === 'daily' ? adjustDay(-1) : adjustMonth(-1)}
          >
            <MaterialCommunityIcons name="chevron-left" size={22} color={COLORS.textSecondary} />
          </TouchableOpacity>

          <View style={styles.periodLabel}>
            <MaterialCommunityIcons
              name={activeTab === 'daily' ? 'calendar-today' : 'calendar'}
              size={16}
              color={COLORS.primary}
              style={{ marginRight: 6 }}
            />
            <AppText weight="bold" size="sm" color={COLORS.text}>
              {activeTab === 'daily'
                ? formatDatePretty(selectedDate)
                : `${MONTH_NAMES[selectedMonth.getMonth()]} ${selectedMonth.getFullYear()}`
              }
            </AppText>
          </View>

          <TouchableOpacity
            style={[
              styles.periodArrow,
              activeTab === 'monthly' &&
              selectedMonth.getMonth() === new Date().getMonth() &&
              selectedMonth.getFullYear() === new Date().getFullYear() &&
              styles.periodArrowDisabled
            ]}
            onPress={() => activeTab === 'daily' ? adjustDay(1) : adjustMonth(1)}
          >
            <MaterialCommunityIcons name="chevron-right" size={22} color={COLORS.textSecondary} />
          </TouchableOpacity>
        </View>

        <TouchableOpacity style={styles.refreshBtn} onPress={loadData} disabled={loading}>
          {loading ? (
            <ActivityIndicator size="small" color={COLORS.primary} />
          ) : (
            <MaterialCommunityIcons name="refresh" size={20} color={COLORS.primary} />
          )}
        </TouchableOpacity>
      </View>

      {/* Main Content Area */}
      {loading ? (
        <ActivityIndicator size="large" color={COLORS.primary} style={styles.centerSpinner} />
      ) : error ? (
        <View style={styles.center}>
          <MaterialCommunityIcons name="alert-circle-outline" size={40} color={COLORS.error} />
          <AppText color={COLORS.error} style={{ marginTop: 8 }}>{error}</AppText>
          <TouchableOpacity onPress={loadData} style={styles.retryBtn}>
            <AppText weight="bold" color={COLORS.primary}>Retry</AppText>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={{ flex: 1 }}>
          
          {/* DAILY VIEW */}
          {activeTab === 'daily' && (
            <View style={{ flex: 1 }}>
              {/* Daily Filter Cards */}
              <View style={styles.statsCardsRow}>
                <TouchableOpacity 
                  style={[styles.statCard, dailyFilter === 'all' && styles.statCardActive]}
                  onPress={() => setDailyFilter('all')}
                >
                  <MaterialCommunityIcons name="account-group" size={20} color={COLORS.primary} />
                  <AppText weight="bold" size="lg" color={COLORS.primary} style={styles.statVal}>
                    {dailyStats.total}
                  </AppText>
                  <AppText size="xs" color={COLORS.textMuted}>Total Staff</AppText>
                </TouchableOpacity>

                <TouchableOpacity 
                  style={[styles.statCard, dailyFilter === 'present' && styles.statCardActive]}
                  onPress={() => setDailyFilter('present')}
                >
                  <MaterialCommunityIcons name="checkbox-marked-circle" size={20} color={COLORS.success} />
                  <AppText weight="bold" size="lg" color={COLORS.success} style={styles.statVal}>
                    {dailyStats.present}
                  </AppText>
                  <AppText size="xs" color={COLORS.textMuted}>Present</AppText>
                </TouchableOpacity>

                <TouchableOpacity 
                  style={[styles.statCard, dailyFilter === 'absent' && styles.statCardActive]}
                  onPress={() => setDailyFilter('absent')}
                >
                  <MaterialCommunityIcons name="close-circle" size={20} color={COLORS.error} />
                  <AppText weight="bold" size="lg" color={COLORS.error} style={styles.statVal}>
                    {dailyStats.absent}
                  </AppText>
                  <AppText size="xs" color={COLORS.textMuted}>Absent</AppText>
                </TouchableOpacity>
              </View>

              {/* Employee List */}
              <FlatList
                data={filteredEmployees}
                keyExtractor={item => item.id}
                renderItem={renderDailyItem}
                contentContainerStyle={styles.listContent}
                ListEmptyComponent={
                  <View style={styles.emptyList}>
                    <MaterialCommunityIcons name="account-search-outline" size={44} color={COLORS.textMuted} />
                    <AppText size="sm" color={COLORS.textMuted} style={{ marginTop: 12 }}>
                      No matching employee records found.
                    </AppText>
                  </View>
                }
              />
            </View>
          )}

          {/* MONTHLY VIEW */}
          {activeTab === 'monthly' && (
            <View style={{ flex: 1 }}>
              <View style={styles.workingDaysBanner}>
                <MaterialCommunityIcons name="information-outline" size={16} color={COLORS.primary} style={{ marginRight: 6 }} />
                <AppText size="xs" color={COLORS.textSecondary}>
                  Month has <AppText weight="bold" size="xs" color={COLORS.primary}>{workingDays} working days</AppText> (Sundays & holidays excluded).
                </AppText>
              </View>

              {/* Employee Summary List */}
              <FlatList
                data={filteredEmployees}
                keyExtractor={item => item.id}
                renderItem={renderMonthlyItem}
                contentContainerStyle={styles.listContent}
                ListEmptyComponent={
                  <View style={styles.emptyList}>
                    <MaterialCommunityIcons name="account-outline" size={44} color={COLORS.textMuted} />
                    <AppText size="sm" color={COLORS.textMuted} style={{ marginTop: 12 }}>
                      No employee summaries available.
                    </AppText>
                  </View>
                }
              />
            </View>
          )}

          {/* HOLIDAYS CALENDAR VIEW */}
          {activeTab === 'calendar' && (
            <ScrollView contentContainerStyle={styles.calendarScroll}>
              
              {/* Weekday headers */}
              <View style={styles.weekdayRow}>
                {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => (
                  <AppText 
                    key={day} 
                    weight="bold" 
                    size="xs" 
                    color={day === 'Sun' ? COLORS.error : COLORS.textSecondary}
                    style={styles.weekdayLabel}
                  >
                    {day}
                  </AppText>
                ))}
              </View>

              {/* Grid cells */}
              <View style={styles.calendarGrid}>
                {calendarCells.map((cell, idx) => {
                  if (cell.blank) {
                    return <View key={`blank-${idx}`} style={styles.calendarCellBlank} />;
                  }

                  const isSunday = dayOfWeek(cell.dateStr) === 0;
                  const isToday = cell.dateStr === todayStr();
                  const holiday = holidayByDate.get(cell.dateStr);
                  
                  // Style colors computation
                  let bg = COLORS.white;
                  let border = COLORS.border;
                  let textColor = COLORS.text;

                  if (isToday) {
                    bg = '#E8F9EE';
                    border = COLORS.success;
                    textColor = COLORS.success;
                  } else if (isSunday) {
                    bg = '#FFEBEE';
                    border = '#EF9A9A';
                    textColor = COLORS.error;
                  } else if (holiday) {
                    if (holiday.is_custom) {
                      bg = COLORS.primaryLight;
                      border = COLORS.primary;
                      textColor = COLORS.primary;
                    } else {
                      bg = '#FFF8E1';
                      border = COLORS.warning;
                      textColor = '#B25E00';
                    }
                  }

                  return (
                    <Pressable
                      key={cell.dateStr}
                      style={[styles.calendarCell, { backgroundColor: bg, borderColor: border }]}
                      onPress={() => handleCalendarDayPress(cell)}
                      disabled={isSunday}
                    >
                      <AppText weight={isToday || holiday ? 'bold' : 'medium'} size="sm" color={textColor}>
                        {cell.day}
                      </AppText>
                      
                      {holiday && !isSunday && (
                        <View style={[styles.cellDot, { backgroundColor: holiday.is_custom ? COLORS.primary : COLORS.warning }]} />
                      )}
                      {isSunday && (
                        <View style={[styles.cellDot, { backgroundColor: COLORS.error }]} />
                      )}
                    </Pressable>
                  );
                })}
              </View>

              {/* Holiday List below Calendar */}
              {holidaysList.length > 0 && (
                <View style={styles.holidayListSection}>
                  <AppText weight="bold" size="xs" color={COLORS.textMuted} style={styles.sectionHeaderLabel}>
                    HOLIDAYS THIS YEAR
                  </AppText>
                  
                  {holidaysList.map(h => (
                    <View key={h.id} style={styles.holidayListItem}>
                      <View style={[styles.holidayItemDot, { backgroundColor: h.is_custom ? COLORS.primary : COLORS.warning }]} />
                      <View style={{ flex: 1 }}>
                        <AppText weight="bold" size="sm" color={COLORS.text}>{h.name}</AppText>
                        <AppText size="xs" color={COLORS.textMuted}>{formatDatePretty(h.holiday_date)}</AppText>
                      </View>
                      {h.is_custom && (
                        <View style={styles.customHolidayBadge}>
                          <AppText size="xs" weight="bold" color={COLORS.primary}>Custom</AppText>
                        </View>
                      )}
                    </View>
                  ))}
                </View>
              )}
            </ScrollView>
          )}

        </View>
      )}

      {/* ── DAILY TIMELINE DETAIL MODAL ───────────────────────── */}
      <Modal visible={!!selectedDailyDetail} transparent animationType="slide" onRequestClose={() => setSelectedDailyDetail(null)}>
        <Pressable style={styles.modalOverlay} onPress={() => setSelectedDailyDetail(null)}>
          <View style={styles.bottomSheet} onStartShouldSetResponder={() => true}>
            
            <View style={styles.modalHeader}>
              <View>
                <AppText weight="bold" size="md" color={COLORS.text}>{selectedDailyDetail?.name}</AppText>
                <AppText size="xs" color={COLORS.textMuted}>Daily Log • {formatDatePretty(selectedDate)}</AppText>
              </View>
              <TouchableOpacity style={styles.closeModalBtn} onPress={() => setSelectedDailyDetail(null)}>
                <MaterialCommunityIcons name="close" size={20} color={COLORS.textSecondary} />
              </TouchableOpacity>
            </View>

            <ScrollView contentContainerStyle={styles.detailModalScroll}>
              <View style={styles.timelineContainer}>
                
                {/* Check In Timeline Node */}
                <View style={styles.timelineNode}>
                  <View style={styles.timelineGraphic}>
                    <View style={[styles.timelineCircle, { backgroundColor: COLORS.success }]} />
                    <View style={styles.timelineLine} />
                  </View>
                  <View style={styles.timelineCard}>
                    <View style={styles.timelineCardHeader}>
                      <AppText weight="bold" size="sm" color={COLORS.success}>Check In</AppText>
                      <AppText weight="bold" size="md" color={COLORS.text}>
                        {fmtTime(selectedDailyDetail?.checkin_time)}
                      </AppText>
                    </View>
                    <View style={styles.timelineCardBody}>
                      <AppText size="xs" color={COLORS.textMuted} numberOfLines={1}>
                        GPS: {fmtCoord(selectedDailyDetail?.checkin_lat)}, {fmtCoord(selectedDailyDetail?.checkin_lng)}
                      </AppText>
                      {selectedDailyDetail?.checkin_lat && (
                        <TouchableOpacity 
                          style={styles.mapLink}
                          onPress={() => Linking.openURL(`https://maps.google.com/?q=${selectedDailyDetail.checkin_lat},${selectedDailyDetail.checkin_lng}`)}
                        >
                          <MaterialCommunityIcons name="map-marker-outline" size={14} color={COLORS.primary} />
                          <AppText size="xs" weight="bold" color={COLORS.primary} style={{ marginLeft: 4 }}>
                            Show on Google Maps
                          </AppText>
                        </TouchableOpacity>
                      )}
                    </View>
                  </View>
                </View>

                {/* Check Out Timeline Node */}
                <View style={styles.timelineNode}>
                  <View style={styles.timelineGraphic}>
                    <View style={[styles.timelineCircle, { backgroundColor: selectedDailyDetail?.checkout_time ? COLORS.primary : COLORS.disabled }]} />
                  </View>
                  <View style={styles.timelineCard}>
                    <View style={styles.timelineCardHeader}>
                      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                        <AppText weight="bold" size="sm" color={selectedDailyDetail?.checkout_time ? COLORS.primary : COLORS.textMuted}>
                          Check Out
                        </AppText>
                        {selectedDailyDetail?.is_auto_checkout && (
                          <View style={styles.autoCheckoutBadge}>
                            <AppText size="xs" weight="bold" color={COLORS.error}>Auto</AppText>
                          </View>
                        )}
                      </View>
                      <AppText weight="bold" size="md" color={selectedDailyDetail?.checkout_time ? COLORS.text : COLORS.textMuted}>
                        {fmtTime(selectedDailyDetail?.checkout_time)}
                      </AppText>
                    </View>
                    
                    {selectedDailyDetail?.checkout_time ? (
                      <View style={styles.timelineCardBody}>
                        <AppText size="xs" color={COLORS.textMuted} numberOfLines={1}>
                          GPS: {fmtCoord(selectedDailyDetail.checkout_lat)}, {fmtCoord(selectedDailyDetail.checkout_lng)}
                        </AppText>
                        <TouchableOpacity 
                          style={styles.mapLink}
                          onPress={() => Linking.openURL(`https://maps.google.com/?q=${selectedDailyDetail.checkout_lat},${selectedDailyDetail.checkout_lng}`)}
                        >
                          <MaterialCommunityIcons name="map-marker-outline" size={14} color={COLORS.primary} />
                          <AppText size="xs" weight="bold" color={COLORS.primary} style={{ marginLeft: 4 }}>
                            Show on Google Maps
                          </AppText>
                        </TouchableOpacity>
                      </View>
                    ) : (
                      <View style={styles.timelineCardBody}>
                        <AppText size="xs" color={COLORS.textMuted}>
                          Employee is currently checked in.
                        </AppText>
                      </View>
                    )}
                  </View>
                </View>

                {/* Hours worked, with the lunch break taken out. Only shown for
                    a closed shift — an open one has no length yet. */}
                {shiftHours(selectedDailyDetail || {}) !== null && (
                  <View style={styles.hoursRow}>
                    <AppText size="xs" color={COLORS.textSecondary}>HOURS WORKED</AppText>
                    <AppText weight="bold" size="md" color={COLORS.text}>
                      {shiftHours(selectedDailyDetail)} h
                    </AppText>
                  </View>
                )}

              </View>
            </ScrollView>

          </View>
        </Pressable>
      </Modal>

      {/* ── MONTHLY TIMELINE DETAIL MODAL ─────────────────────── */}
      <Modal visible={!!selectedMonthlyDetail} transparent animationType="slide" onRequestClose={() => setSelectedMonthlyDetail(null)}>
        <Pressable style={styles.modalOverlay} onPress={() => setSelectedMonthlyDetail(null)}>
          <View style={styles.bottomSheetLarge} onStartShouldSetResponder={() => true}>
            
            <View style={styles.modalHeader}>
              <View>
                <AppText weight="bold" size="md" color={COLORS.text}>{selectedMonthlyDetail?.name}</AppText>
                <AppText size="xs" color={COLORS.textMuted}>
                  Monthly Attendance • {MONTH_NAMES[selectedMonth.getMonth()]} {selectedMonth.getFullYear()}
                </AppText>
              </View>
              <TouchableOpacity style={styles.closeModalBtn} onPress={() => setSelectedMonthlyDetail(null)}>
                <MaterialCommunityIcons name="close" size={20} color={COLORS.textSecondary} />
              </TouchableOpacity>
            </View>

            {monthlyDetailLoading ? (
              <ActivityIndicator size="large" color={COLORS.primary} style={styles.centerSpinner} />
            ) : (
              <View style={{ flex: 1 }}>
                
                {/* Mini Summary counters */}
                <View style={styles.miniSummaryRow}>
                  <View style={styles.miniSummaryItem}>
                    <AppText weight="bold" size="md" color={COLORS.success}>
                      {monthlyDetailRows.filter(r => r.status === 'present').length}
                    </AppText>
                    <AppText size="xs" color={COLORS.textMuted}>Present</AppText>
                  </View>
                  <View style={styles.miniSummaryDivider} />
                  <View style={styles.miniSummaryItem}>
                    <AppText weight="bold" size="md" color={COLORS.error}>
                      {monthlyDetailRows.filter(r => r.status === 'absent').length}
                    </AppText>
                    <AppText size="xs" color={COLORS.textMuted}>Absent</AppText>
                  </View>
                  <View style={styles.miniSummaryDivider} />
                  <View style={styles.miniSummaryItem}>
                    <AppText weight="bold" size="md" color={COLORS.warning}>
                      {monthlyDetailRows.filter(r => r.status === 'holiday').length}
                    </AppText>
                    <AppText size="xs" color={COLORS.textMuted}>Holidays</AppText>
                  </View>
                </View>

                {/* Day logs list */}
                <FlatList
                  data={monthlyDetailRows}
                  keyExtractor={item => item.date}
                  contentContainerStyle={styles.detailScrollContent}
                  renderItem={({ item }) => {
                    // Row style based on status
                    let rowBg = COLORS.surface;
                    let dotColor = COLORS.border;
                    let textColor = COLORS.text;
                    let iconName = 'checkbox-blank-circle-outline';

                    if (item.status === 'present') {
                      rowBg = '#F0FDF4'; // light emerald
                      dotColor = COLORS.success;
                      textColor = COLORS.success;
                      iconName = 'check-circle';
                    } else if (item.status === 'absent') {
                      rowBg = '#FFF5F5'; // light red
                      dotColor = COLORS.error;
                      textColor = COLORS.error;
                      iconName = 'close-circle';
                    } else if (item.status === 'holiday') {
                      rowBg = '#FFF8E1'; // light amber
                      dotColor = COLORS.warning;
                      textColor = '#B25E00';
                      iconName = 'star-circle';
                    } else if (item.status === 'future') {
                      rowBg = COLORS.white;
                      dotColor = COLORS.disabledText;
                      textColor = COLORS.textMuted;
                      iconName = 'circle-double';
                    }

                    return (
                      <View style={[styles.dayLogRow, { backgroundColor: rowBg }]}>
                        <View style={styles.dayLogLeft}>
                          <AppText weight="bold" size="sm" color={COLORS.text} style={styles.dayLogDateNum}>
                            {item.dayNum}
                          </AppText>
                          <AppText size="xs" color={COLORS.textMuted} style={styles.dayLogDateName}>
                            {item.dayName}
                          </AppText>
                          <MaterialCommunityIcons name={iconName} size={16} color={dotColor} style={styles.dayLogIcon} />
                          <AppText weight="bold" size="xs" color={textColor}>
                            {item.label}
                          </AppText>
                        </View>
                        
                        {item.status === 'present' && (
                          <AppText size="xs" color={COLORS.textSecondary} weight="medium">
                            {fmtTime(item.checkin_time)} → {item.checkout_time ? fmtTime(item.checkout_time) : 'Active'}
                          </AppText>
                        )}
                      </View>
                    );
                  }}
                />

              </View>
            )}

          </View>
        </Pressable>
      </Modal>

      {/* ── CREATE / REMOVE HOLIDAY MODAL ─────────────────────── */}
      <Modal visible={!!holidayForm} transparent animationType="fade" onRequestClose={() => setHolidayForm(null)}>
        <View style={[styles.modalOverlay, { justifyContent: 'center' }]}>
          <View style={styles.dialogBox}>
            
            <View style={styles.modalHeader}>
              <View>
                <AppText weight="bold" size="md" color={COLORS.text}>
                  {holidayForm?.existingHoliday ? 'Holiday Details' : 'Mark as Holiday'}
                </AppText>
                <AppText size="xs" color={COLORS.textMuted}>
                  {holidayForm ? formatDatePretty(holidayForm.dateStr) : ''}
                </AppText>
              </View>
              <TouchableOpacity style={styles.closeModalBtn} onPress={() => setHolidayForm(null)}>
                <MaterialCommunityIcons name="close" size={20} color={COLORS.textSecondary} />
              </TouchableOpacity>
            </View>

            <View style={styles.dialogBody}>
              <AppText size="xs" weight="bold" color={COLORS.textSecondary} style={{ marginBottom: 6 }}>
                HOLIDAY NAME
              </AppText>
              
              <TextInput
                style={styles.dialogInput}
                placeholder="e.g. Diwali Festival"
                placeholderTextColor={COLORS.textMuted}
                value={holidayForm?.name || ''}
                onChangeText={(text) => setHolidayForm(prev => ({ ...prev, name: text }))}
                editable={!holidayForm?.existingHoliday || !!holidayForm?.existingHoliday?.is_custom}
              />
              
              {!holidayForm?.existingHoliday ? (
                <Button
                  label="Mark as Holiday"
                  loadingLabel="Saving..."
                  loading={holidaySaving}
                  onPress={handleSaveHoliday}
                  style={{ marginTop: 20 }}
                  disabled={!holidayForm?.name?.trim()}
                />
              ) : (
                <View style={{ marginTop: 20, gap: 12 }}>
                  {holidayForm.existingHoliday.is_custom ? (
                    <>
                      <Button
                        label="Update Name"
                        loadingLabel="Updating..."
                        loading={holidaySaving}
                        onPress={handleSaveHoliday}
                        disabled={!holidayForm.name.trim()}
                      />
                      <Button
                        label="Remove Holiday"
                        variant="quiet"
                        onPress={() => handleDeleteHoliday(holidayForm.existingHoliday.id)}
                        style={{ borderColor: COLORS.error }}
                      />
                    </>
                  ) : (
                    <AppText size="xs" color={COLORS.textMuted} style={{ textAlign: 'center', marginTop: 10 }}>
                      Standard calendar holidays cannot be modified or removed.
                    </AppText>
                  )}
                </View>
              )}
            </View>

          </View>
        </View>
      </Modal>

    </View>
  );
}

const styles = StyleSheet.create({
  container: { 
    flex: 1, 
    backgroundColor: COLORS.background 
  },
  center: { 
    flex: 1, 
    justifyContent: 'center', 
    alignItems: 'center',
    padding: 24
  },
  centerSpinner: {
    marginTop: 100
  },
  refreshBtn: {
    padding: 8,
    borderRadius: 10,
    backgroundColor: COLORS.primaryLight,
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center'
  },
  tabsContainer: {
    height: 52,
    flexDirection: 'row',
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    paddingHorizontal: 12,
    gap: 8,
    alignItems: 'center'
  },
  tabButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 38,
    borderRadius: 10,
  },
  tabButtonActive: {
    backgroundColor: COLORS.primaryLight,
  },
  filterBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  // Narrow screens put the date nav on its own line above the search field —
  // side by side there is not enough width left for either to stay readable.
  filterBarStacked: {
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: 10,
  },
  periodNav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  periodArrow: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: COLORS.surfaceLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  periodArrowDisabled: {
    opacity: 0.25
  },
  periodLabel: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statsCardsRow: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 10
  },
  statCard: {
    flex: 1,
    backgroundColor: COLORS.surface,
    borderRadius: 14,
    padding: 12,
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: COLORS.border,
    shadowColor: COLORS.black,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.02,
    shadowRadius: 6,
    elevation: 2
  },
  statCardActive: {
    borderColor: COLORS.primary,
    backgroundColor: COLORS.primaryLight
  },
  statVal: {
    marginTop: 4,
    marginBottom: 2
  },
  searchContainer: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    paddingHorizontal: 12,
    height: 44,
  },
  searchIcon: {
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: COLORS.text,
    fontFamily: Platform.OS === 'ios' ? 'System' : 'AppFont-Regular',
    height: '100%',
    padding: 0
  },
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 32,
    gap: 10
  },
  employeeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surface,
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    shadowColor: COLORS.primary,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.02,
    shadowRadius: 8,
    elevation: 1
  },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12
  },
  employeeInfo: {
    flex: 1,
    justifyContent: 'center'
  },
  timesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4
  },
  pulseContainer: {
    flexDirection: 'row',
    alignItems: 'center'
  },
  pulseIndicator: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: COLORS.success,
    marginLeft: 6
  },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
    marginRight: 6
  },
  monthStatsRow: {
    flexDirection: 'row',
    gap: 12,
    marginRight: 10
  },
  monthStatCountItem: {
    alignItems: 'center',
    width: 48
  },
  arrowWrap: {
    justifyContent: 'center'
  },
  workingDaysBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.primaryLight,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    marginHorizontal: 16,
    marginVertical: 12
  },
  emptyList: {
    alignItems: 'center',
    paddingVertical: 60
  },
  calendarScroll: {
    paddingBottom: 40
  },
  legendContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 14,
    paddingHorizontal: 20,
    paddingVertical: 14,
    backgroundColor: COLORS.surface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    justifyContent: 'center'
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center'
  },
  legendDot: {
    width: 12,
    height: 12,
    borderRadius: 3,
    borderWidth: 1,
    marginRight: 6
  },
  weekdayRow: {
    flexDirection: 'row',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    backgroundColor: COLORS.surface
  },
  weekdayLabel: {
    width: '14.285%',
    textAlign: 'center',
  },
  calendarGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    backgroundColor: COLORS.background
  },
  calendarCellBlank: {
    width: '14.285%',
    height: 70,
    backgroundColor: COLORS.background
  },
  calendarCell: {
    width: '14.285%',
    height: 70,
    borderWidth: 0.5,
    borderColor: COLORS.border,
    padding: 8,
    justifyContent: 'space-between'
  },
  cellDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    alignSelf: 'flex-end'
  },
  holidayListSection: {
    marginTop: 20,
    paddingHorizontal: 16
  },
  sectionHeaderLabel: {
    marginBottom: 10,
    letterSpacing: 0.5
  },
  holidayListItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surface,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    marginBottom: 8
  },
  holidayItemDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 12
  },
  customHolidayBadge: {
    backgroundColor: COLORS.primaryLight,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6
  },
  retryBtn: {
    marginTop: 14,
    paddingVertical: 6,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.primary
  },

  // Modals / Sheets Styles
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
    justifyContent: 'flex-end',
  },
  bottomSheet: {
    backgroundColor: COLORS.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    maxHeight: '75%',
    shadowColor: COLORS.black,
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 10
  },
  bottomSheetLarge: {
    backgroundColor: COLORS.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    height: '85%',
    shadowColor: COLORS.black,
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 10
  },
  dialogBox: {
    backgroundColor: COLORS.surface,
    borderRadius: 20,
    padding: 20,
    margin: 24,
    alignSelf: 'center',
    width: '90%',
    maxWidth: 420,
    shadowColor: COLORS.black,
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.15,
    shadowRadius: 20,
    elevation: 12
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    marginBottom: 16
  },
  closeModalBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: COLORS.surfaceLight,
    alignItems: 'center',
    justifyContent: 'center'
  },
  detailModalScroll: {
    paddingBottom: 24
  },
  timelineContainer: {
    paddingLeft: 12,
    marginTop: 10
  },
  timelineNode: {
    flexDirection: 'row',
    marginBottom: 20
  },
  timelineGraphic: {
    alignItems: 'center',
    marginRight: 16,
    width: 16
  },
  timelineCircle: {
    width: 16,
    height: 16,
    borderRadius: 8,
    zIndex: 2
  },
  timelineLine: {
    position: 'absolute',
    top: 16,
    bottom: -24,
    width: 2,
    backgroundColor: COLORS.border,
    zIndex: 1
  },
  timelineCard: {
    flex: 1,
    backgroundColor: COLORS.background,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 12
  },
  timelineCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6
  },
  timelineCardBody: {
    gap: 4
  },
  hoursRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 16,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  mapLink: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 6
  },
  autoCheckoutBadge: {
    backgroundColor: COLORS.errorLight,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    marginLeft: 6
  },
  miniSummaryRow: {
    flexDirection: 'row',
    backgroundColor: COLORS.surfaceLight,
    borderRadius: 12,
    paddingVertical: 10,
    marginBottom: 14
  },
  miniSummaryItem: {
    flex: 1,
    alignItems: 'center'
  },
  miniSummaryDivider: {
    width: 1,
    backgroundColor: COLORS.border,
    alignSelf: 'stretch'
  },
  detailScrollContent: {
    paddingBottom: 30,
    gap: 8
  },
  dayLogRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.border
  },
  dayLogLeft: {
    flexDirection: 'row',
    alignItems: 'center'
  },
  dayLogDateNum: {
    width: 22
  },
  dayLogDateName: {
    width: 32,
    marginRight: 8
  },
  dayLogIcon: {
    marginRight: 6
  },
  dialogBody: {
    paddingVertical: 8
  },
  dialogInput: {
    height: 48,
    borderWidth: 1.5,
    borderColor: COLORS.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    fontSize: 14,
    color: COLORS.text,
    backgroundColor: COLORS.background,
    marginTop: 4
  }
});
