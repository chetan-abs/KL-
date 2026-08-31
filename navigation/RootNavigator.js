import React, { useState, useEffect } from 'react';
import { View, TouchableOpacity, StyleSheet, ActivityIndicator, Image, Modal, TouchableWithoutFeedback } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { COLORS } from '../constants/colors';
import { useAuth } from '../context/AuthContext';
import { userCan } from '../utils/permissions';
import AppText from '../components/AppText';

import LoginScreen from '../screens/LoginScreen';
import HomeScreen from '../screens/HomeScreen';
import EmployeeListScreen from '../screens/EmployeeListScreen';
import AttendanceScreen from '../screens/AttendanceScreen';
import LiveTrackingScreen from '../screens/LiveTrackingScreen';
import ProfileScreen from '../screens/ProfileScreen';
import CheckinGateScreen from '../screens/CheckinGateScreen';
import OrdersScreen from '../screens/OrdersScreen';
import ItemMasterScreen from '../screens/ItemMasterScreen';
import CustomersScreen from '../screens/CustomersScreen';
import api, { describeError, setShiftEndedHandler } from '../services/api';
import { confirmAction, showAlert } from '../services/confirm';
import {
  startLocationTracking,
  stopLocationTracking,
  getCurrentLocation,
  describeTrackingState,
} from '../utils/location';

const Stack = createNativeStackNavigator();

const theme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    background: COLORS.background,
    card: COLORS.surface,
    text: COLORS.text,
    border: COLORS.border,
    primary: COLORS.primary,
  },
};

/**
 * Turns a failed GPS read into something worth reading.
 *
 * utils/location.js used to answer a failed fix with Mumbai's coordinates, so
 * this path did not exist and a check-in recorded a place the employee had
 * never been. It fails now, and the reason reaches the user.
 */
function describeLocationError(err) {
  const message = String(err?.message || '');
  if (/denied|permission/i.test(message)) {
    return 'Location permission is required to record attendance.';
  }
  if (/unavailable|timeout|position/i.test(message)) {
    return 'Could not get a GPS fix. Move somewhere with a clearer view of the sky and try again.';
  }
  return message || 'Could not read your location.';
}

function MainAppContainer() {
  const [activePage, setActivePage] = useState('dashboard');
  const [trackingUser, setTrackingUser] = useState(null);
  const [userDropdownVisible, setUserDropdownVisible] = React.useState(false);
  const [masterDropdownVisible, setMasterDropdownVisible] = React.useState(false);
  const [logoutDropdownVisible, setLogoutDropdownVisible] = React.useState(false);
  const [checkedInState, setCheckedInState] = useState('loading'); // 'loading' | 'gate' | 'unlocked'
  const [checkinData, setCheckinData] = useState(null);
  const { user, signOut } = useAuth();
  const insets = useSafeAreaInsets();

  // An open shift is one that has been started and not ended. A closed one
  // still unlocks the app — see loadShift.
  const onShift = Boolean(checkinData && !checkinData.checkout_time);
  const onBreak = Boolean(checkinData?.lunch_out_time && !checkinData.lunch_in_time);

  /**
   * Reads today's employee-day and decides what the app does with it.
   *
   * The gate is only for someone who has not started their day. Checking out
   * used to send them back to it, where the check-in button could only ever
   * return "already checked in for today" — with no way to dismiss the modal
   * and no sign-out inside it, the app was unusable until the date rolled over.
   * A completed day now leaves the app open and simply has nothing left to do.
   */
  const loadShift = React.useCallback(async () => {
    try {
      const res = await api.get('/attendance/today');
      const checkin = res.data?.checkin || null;
      setCheckinData(checkin);

      if (!checkin) {
        setCheckedInState('gate');
        return;
      }

      setCheckedInState('unlocked');

      if (checkin.checkout_time) {
        stopLocationTracking();
      } else if (checkin.lunch_out_time && !checkin.lunch_in_time) {
        stopLocationTracking();
      } else {
        startLocationTracking();
      }
    } catch (err) {
      // Failing to the gate is the safe default: it is the only screen that can
      // recover the session, and it now carries a sign-out of its own.
      console.warn('[RootNavigator] Could not read today\'s shift:', describeError(err));
      setCheckedInState('gate');
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    loadShift();
  }, [user, loadShift]);

  // The background task cannot reach into React, so it reports through the API
  // client instead: the server refused a ping because the shift is closed.
  useEffect(() => setShiftEndedHandler(() => {
    stopLocationTracking();
    loadShift();
  }), [loadShift]);

  /** Every shift action needs a fix, and none of them proceeds without one. */
  async function withLocation(run) {
    let loc;
    try {
      loc = await getCurrentLocation();
    } catch (err) {
      showAlert('Location needed', describeLocationError(err));
      return;
    }
    await run(loc);
  }

  const handleLogout = () => {
    setLogoutDropdownVisible(false);
    confirmAction(
      'Confirm Logout',
      'Are you sure you want to log out of your session?',
      () => {
        stopLocationTracking();
        signOut();
      }
    );
  };

  const handleCheckout = () => {
    setLogoutDropdownVisible(false);
    confirmAction(
      'Confirm Check Out',
      'This ends your shift for today. You can keep using the app, but you will not be able to check in again until tomorrow.',
      () =>
        withLocation(async (loc) => {
          try {
            const res = await api.post('/attendance/checkout', {
              latitude: loc.latitude,
              longitude: loc.longitude,
            });
            setCheckinData(res.data.checkin);
            stopLocationTracking();
            showAlert('Checked Out', 'Shift ended. Location tracking has stopped.');
          } catch (err) {
            showAlert('Error', describeError(err));
          }
        })
    );
  };

  const handleLunchOut = () => {
    setLogoutDropdownVisible(false);
    confirmAction(
      'Go on Lunch Break',
      'Location tracking pauses until you resume work.',
      () =>
        withLocation(async (loc) => {
          try {
            const res = await api.post('/attendance/lunch-out', {
              latitude: loc.latitude,
              longitude: loc.longitude,
            });
            setCheckinData(res.data.checkin);
            stopLocationTracking();
            showAlert('Lunch Break Started', 'Location tracking paused.');
          } catch (err) {
            showAlert('Error', describeError(err));
          }
        })
    );
  };

  const handleLunchIn = () => {
    setLogoutDropdownVisible(false);
    confirmAction(
      'Resume Work',
      'Are you ready to resume work? Location tracking will start again.',
      () =>
        withLocation(async (loc) => {
          try {
            const res = await api.post('/attendance/lunch-in', {
              latitude: loc.latitude,
              longitude: loc.longitude,
            });
            setCheckinData(res.data.checkin);
            const tracking = await startLocationTracking();
            const caveat = tracking.started ? null : describeTrackingState(tracking.reason);
            showAlert('Work Resumed', caveat || 'Location tracking resumed.');
          } catch (err) {
            showAlert('Error', describeError(err));
          }
        })
    );
  };

  // Tabs the account holds a view grant for. Every page listed here exists in
  // renderActivePage, and every grant offered by the employee form maps to one
  // of them — a grant that opens nothing is worse than no grant at all.
  const navTabs = [
    { key: 'dashboard', label: 'Dashboard' },
    { key: 'orders', label: 'Order', permission: 'orders.view' },
  ].filter((tab) => !tab.permission || userCan(user, tab.permission));

  const masterSubTabs = [
    { key: 'itemMaster', label: 'Item Master', icon: '📦', permission: 'items.view' },
    { key: 'customers', label: 'Customers', icon: '🏪', permission: 'customers.view' },
  ].filter((tab) => userCan(user, tab.permission));

  // Profile is always listed — it is the user's own account, and it is where
  // sign-out and the password change live.
  const userSubTabs = [
    { key: 'employees', label: 'Employees', icon: '👥', permission: 'employees.view' },
    { key: 'attendance', label: 'Attendance', icon: '📅', permission: 'attendance.view' },
    { key: 'liveTracking', label: 'Live Tracking', icon: '📍', permission: 'live_tracking.view' },
    { key: 'profile', label: 'Profile', icon: '⚙️' },
  ].filter((tab) => !tab.permission || userCan(user, tab.permission));

  const subTabKeys = userSubTabs.map((tab) => tab.key);
  const masterSubTabKeys = masterSubTabs.map((tab) => tab.key);

  const renderActivePage = () => {
    // A grant revoked mid-session leaves activePage pointing at a page the user
    // may no longer open, so the tab list — not activePage — decides what is
    // allowed to render. The server rejects the calls either way; this stops the
    // user staring at an empty screen full of 403s.
    const allValidKeys = [
      ...navTabs.map((t) => t.key),
      ...subTabKeys,
      ...masterSubTabKeys,
    ];
    if (!allValidKeys.includes(activePage)) {
      return <HomeScreen onNavigate={setActivePage} />;
    }

    switch (activePage) {
      case 'dashboard': return <HomeScreen onNavigate={setActivePage} />;
      // These pages carry no back control of their own — the navbar logo is the
      // way back to the dashboard, so there is no goBack to hand them.
      case 'employees': return <EmployeeListScreen />;
      case 'attendance': return <AttendanceScreen onNavigate={setActivePage} onTrackUser={setTrackingUser} />;
      case 'liveTracking': return <LiveTrackingScreen initialUser={trackingUser} />;
      case 'orders': return <OrdersScreen />;
      case 'itemMaster': return <ItemMasterScreen />;
      case 'customers': return <CustomersScreen />;
      case 'profile': return <ProfileScreen />;
      default: return <HomeScreen onNavigate={setActivePage} />;
    }
  };

  if (checkedInState === 'loading') {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={COLORS.primary} />
        <AppText size="xs" color={COLORS.textSecondary} style={{ marginTop: 8 }}>
          Verifying shift status...
        </AppText>
      </View>
    );
  }

  return (
    <View style={styles.flex}>
      {/* Top Navbar */}
      <View style={[styles.topNavbar, { paddingTop: Math.max(insets.top, 16) }]}>
        {/* Left Side: ABS Logo — doubles as the way back to the dashboard */}
        <TouchableOpacity
          style={styles.logoContainer}
          onPress={() => setActivePage('dashboard')}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Go to dashboard"
        >
          <Image
            source={require('../assets/abs_logo_redesign.png')}
            style={styles.logoImage}
            resizeMode="contain"
          />
        </TouchableOpacity>

        {/* Right Side: Navigation Links */}
        <View style={styles.navLinks}>
          {navTabs.map(tab => (
            <TouchableOpacity
              key={tab.key}
              style={[styles.navLink, activePage === tab.key && styles.navLinkActive]}
              onPress={() => setActivePage(tab.key)}
            >
              <AppText
                weight={activePage === tab.key ? "bold" : "regular"}
                color={activePage === tab.key ? COLORS.primary : COLORS.textSecondary}
              >
                {tab.label}
              </AppText>
            </TouchableOpacity>
          ))}

          {/* Master Tab with Dropdown — hidden entirely when it would be empty */}
          {masterSubTabs.length ? (
            <TouchableOpacity
              style={[styles.navLink, masterSubTabKeys.includes(activePage) && styles.navLinkActive]}
              onPress={() => setMasterDropdownVisible(true)}
            >
              <AppText
                weight={masterSubTabKeys.includes(activePage) ? "bold" : "regular"}
                color={masterSubTabKeys.includes(activePage) ? COLORS.primary : COLORS.textSecondary}
              >
                Master ▾
              </AppText>
            </TouchableOpacity>
          ) : null}

          {/* User Tab with Dropdown */}
          <TouchableOpacity
            style={[styles.navLink, subTabKeys.includes(activePage) && styles.navLinkActive]}
            onPress={() => setUserDropdownVisible(true)}
          >
            <AppText
                weight={subTabKeys.includes(activePage) ? "bold" : "regular"}
                color={subTabKeys.includes(activePage) ? COLORS.primary : COLORS.textSecondary}
              >
                User ▾
            </AppText>
          </TouchableOpacity>

          {/* Shift and session actions */}
          <TouchableOpacity
            style={styles.navLink}
            onPress={() => setLogoutDropdownVisible(true)}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Shift and session options"
          >
            <MaterialCommunityIcons name="logout" size={20} color={COLORS.error} />
          </TouchableOpacity>
        </View>
      </View>

      {/* User Dropdown Modal overlay */}
      <Modal
        visible={userDropdownVisible}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setUserDropdownVisible(false)}
      >
        <TouchableWithoutFeedback onPress={() => setUserDropdownVisible(false)}>
          <View style={styles.modalOverlay}>
            <View style={styles.dropdownMenu}>
              {userSubTabs.map(sub => (
                <TouchableOpacity
                  key={sub.key}
                  style={styles.dropdownItem}
                  onPress={() => {
                    setActivePage(sub.key);
                    setUserDropdownVisible(false);
                  }}
                >
                  <AppText size="md" style={{ marginRight: 10 }}>{sub.icon}</AppText>
                  <AppText
                    weight={activePage === sub.key ? "bold" : "regular"}
                    color={activePage === sub.key ? COLORS.primary : COLORS.text}
                  >
                    {sub.label}
                  </AppText>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </TouchableWithoutFeedback>
      </Modal>

      {/* Master Dropdown Modal overlay */}
      <Modal
        visible={masterDropdownVisible}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setMasterDropdownVisible(false)}
      >
        <TouchableWithoutFeedback onPress={() => setMasterDropdownVisible(false)}>
          <View style={styles.modalOverlay}>
            <View style={[styles.dropdownMenu, { right: 80 }]}>
              {masterSubTabs.map(sub => (
                <TouchableOpacity
                  key={sub.key}
                  style={styles.dropdownItem}
                  onPress={() => {
                    setActivePage(sub.key);
                    setMasterDropdownVisible(false);
                  }}
                >
                  <AppText size="md" style={{ marginRight: 10 }}>{sub.icon}</AppText>
                  <AppText
                    weight={activePage === sub.key ? "bold" : "regular"}
                    color={activePage === sub.key ? COLORS.primary : COLORS.text}
                  >
                    {sub.label}
                  </AppText>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </TouchableWithoutFeedback>
      </Modal>

      {/* Shift / session dropdown */}
      <Modal
        visible={logoutDropdownVisible}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setLogoutDropdownVisible(false)}
      >
        <TouchableWithoutFeedback onPress={() => setLogoutDropdownVisible(false)}>
          <View style={styles.modalOverlay}>
            <View style={[styles.dropdownMenu, { right: 20 }]}>
              {onShift ? (
                <>
                  {!onBreak ? (
                    <TouchableOpacity style={styles.dropdownItem} onPress={handleLunchOut}>
                      <MaterialCommunityIcons name="food" size={18} color={COLORS.primary} style={{ marginRight: 10 }} />
                      <AppText weight="bold" color={COLORS.primary}>Lunch Break</AppText>
                    </TouchableOpacity>
                  ) : (
                    <TouchableOpacity style={styles.dropdownItem} onPress={handleLunchIn}>
                      <MaterialCommunityIcons name="briefcase-check" size={18} color={COLORS.success} style={{ marginRight: 10 }} />
                      <AppText weight="bold" color={COLORS.success}>Resume Work</AppText>
                    </TouchableOpacity>
                  )}

                  <TouchableOpacity style={styles.dropdownItem} onPress={handleCheckout}>
                    <MaterialCommunityIcons name="location-exit" size={18} color={COLORS.warning} style={{ marginRight: 10 }} />
                    <AppText weight="bold" color={COLORS.warning}>Check Out</AppText>
                  </TouchableOpacity>
                </>
              ) : (
                // Nothing to end, and nothing that would succeed if offered.
                <View style={styles.dropdownNote}>
                  <AppText size="xs" color={COLORS.textMuted}>
                    {checkinData ? 'Shift ended for today.' : 'Not checked in.'}
                  </AppText>
                </View>
              )}

              <TouchableOpacity
                style={styles.dropdownItem}
                onPress={handleLogout}
              >
                <MaterialCommunityIcons name="logout" size={18} color={COLORS.error} style={{ marginRight: 10 }} />
                <AppText weight="bold" color={COLORS.error}>Log Out</AppText>
              </TouchableOpacity>
            </View>
          </View>
        </TouchableWithoutFeedback>
      </Modal>

      {/* Page Content */}
      <View style={styles.contentArea}>
        {renderActivePage()}
      </View>

      {/* Check-In Gate — only for a day that has not been started at all */}
      <Modal visible={checkedInState === 'gate'} transparent={true} animationType="slide">
        <View style={styles.gateBackdrop}>
          <CheckinGateScreen onCheckinSuccess={loadShift} onSignOut={signOut} />
        </View>
      </Modal>
    </View>
  );
}

export default function RootNavigator() {
  const { status } = useAuth();

  if (status === 'restoring') {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={COLORS.primary} />
      </View>
    );
  }

  return (
    <NavigationContainer theme={theme}>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {status === 'signedIn' ? (
          <Stack.Screen name="MainApp" component={MainAppContainer} />
        ) : (
          <Stack.Screen
            name="Login"
            component={LoginScreen}
            options={{ animationTypeForReplace: 'pop' }}
          />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: COLORS.background },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: COLORS.background,
  },
  topNavbar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: COLORS.surface,
    paddingHorizontal: 20,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    shadowColor: COLORS.black,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 10,
    elevation: 4,
    zIndex: 10
  },
  logoContainer: {
    flexDirection: 'row',
    alignItems: 'center'
  },
  logoImage: {
    width: 60,
    height: 40,
  },
  navLinks: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16
  },
  navLink: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  navLinkActive: {
    backgroundColor: COLORS.primaryLight,
  },
  modalOverlay: {
    flex: 1,
  },
  dropdownMenu: {
    position: 'absolute',
    top: 70, // Roughly below the navbar
    right: 20,
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    paddingVertical: 8,
    width: 200,
    borderWidth: 1,
    borderColor: COLORS.border,
    shadowColor: COLORS.black,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.1,
    shadowRadius: 16,
    elevation: 8,
  },
  dropdownItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  dropdownNote: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.borderLight,
  },
  contentArea: {
    flex: 1,
    backgroundColor: COLORS.background
  },
  gateBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    padding: 20,
  },
});
