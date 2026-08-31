import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import api from '../services/api';

const LOCATION_TASK_NAME = 'BACKGROUND_LOCATION_TASK';

// Matches the interval schema.sql documents and purge-locations.js sizes its
// retention against. It was 15 minutes here while both of those said 10.
const PING_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Background location updates are a native capability. On web there is no such
 * API — `startLocationUpdatesAsync` does not exist in expo-location's web
 * build — so tracking cannot run there at all.
 *
 * That used to fail silently inside a try/catch while the UI announced "Live
 * GPS tracking activated", which is why location_logs held five rows after two
 * weeks of use: every one of them written by a check-in or lunch event, none by
 * the task. Callers now get told, and can say so.
 */
export const BACKGROUND_TRACKING_SUPPORTED = Platform.OS !== 'web';

TaskManager.defineTask(LOCATION_TASK_NAME, async ({ data, error }) => {
  if (error) {
    console.warn('[Location] Background task error:', error);
    return;
  }
  if (!data?.locations?.length) return;

  const loc = data.locations[data.locations.length - 1];
  try {
    const token = await AsyncStorage.getItem('kl.auth.token');
    if (!token) {
      // Signed out since the task was registered. Nothing to report to, and
      // nothing to keep reporting for.
      await stopLocationTracking();
      return;
    }

    // The token is passed explicitly because the background JS context may not
    // have run AuthContext, so the module-level token in services/api.js can be
    // empty here even while the user is signed in.
    await api.post(
      '/location/log',
      { latitude: loc.coords.latitude, longitude: loc.coords.longitude },
      { headers: { Authorization: `Bearer ${token}` } }
    );
  } catch (err) {
    const code = err.response?.data?.code;
    // The server is the authority on whether a shift is open. If it says the
    // shift has ended, the task stops rather than retrying every ten minutes
    // against a check-in that closed hours ago.
    if (code === 'NOT_ON_SHIFT') {
      await stopLocationTracking();
      return;
    }
    if (code === 'ON_BREAK') return;
    console.warn('[Location] Failed to log background location:', err.message);
  }
});

export async function requestLocationPermissions() {
  const { status: fgStatus } = await Location.requestForegroundPermissionsAsync();
  if (fgStatus !== 'granted') {
    return { granted: false, background: false, reason: 'foreground-denied' };
  }

  if (!BACKGROUND_TRACKING_SUPPORTED) {
    // Foreground is all there is on web, and it is enough to check in.
    return { granted: true, background: false, reason: 'no-background-on-web' };
  }

  try {
    const { status: bgStatus } = await Location.requestBackgroundPermissionsAsync();
    return {
      granted: true,
      background: bgStatus === 'granted',
      reason: bgStatus === 'granted' ? null : 'background-denied',
    };
  } catch (e) {
    console.warn('[Location] Background permission request failed:', e);
    return { granted: true, background: false, reason: 'background-unavailable' };
  }
}

/**
 * The device's position, or a thrown error.
 *
 * This used to return Mumbai — 19.0760, 72.8777 — whenever the fix failed, and
 * the check-in screen rendered that as "GPS Fixed ✓, accuracy ±10 m". For a
 * Guwahati business that meant attendance records carrying precise-looking
 * evidence of somewhere the employee had never been. A failed fix is now a
 * failure; the caller decides what to tell the user.
 */
export async function getCurrentLocation() {
  const { coords } = await Location.getCurrentPositionAsync({
    accuracy: Location.Accuracy.Balanced,
  });
  return {
    latitude: coords.latitude,
    longitude: coords.longitude,
    accuracy: coords.accuracy,
  };
}

/**
 * Starts background pings. Returns { started, reason } — never throws, and
 * never claims to have started something it did not.
 */
export async function startLocationTracking() {
  if (!BACKGROUND_TRACKING_SUPPORTED) {
    return { started: false, reason: 'unsupported-platform' };
  }

  try {
    const permission = await requestLocationPermissions();
    if (!permission.background) {
      return { started: false, reason: permission.reason || 'background-denied' };
    }

    const isRegistered = await TaskManager.isTaskRegisteredAsync(LOCATION_TASK_NAME);
    if (isRegistered) return { started: true, reason: 'already-running' };

    await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
      accuracy: Location.Accuracy.Balanced,
      timeInterval: PING_INTERVAL_MS,
      distanceInterval: 100,
      deferredUpdatesInterval: PING_INTERVAL_MS,
      showsBackgroundLocationIndicator: true,
      foregroundService: {
        notificationTitle: 'KL Electricals',
        notificationBody: 'Your location is recorded while you are checked in.',
        notificationColor: '#1E3A6B',
      },
    });
    return { started: true, reason: null };
  } catch (err) {
    console.warn('[Location] Failed to start tracking:', err);
    return { started: false, reason: 'start-failed', error: err };
  }
}

export async function stopLocationTracking() {
  if (!BACKGROUND_TRACKING_SUPPORTED) return;
  try {
    const isRegistered = await TaskManager.isTaskRegisteredAsync(LOCATION_TASK_NAME);
    if (isRegistered) {
      await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
    }
  } catch (err) {
    console.warn('[Location] Failed to stop tracking:', err);
  }
}

/** A sentence for the user explaining why tracking is not running. */
export function describeTrackingState(reason) {
  switch (reason) {
    case 'unsupported-platform':
    case 'no-background-on-web':
      return 'Background location is not available in a browser, so your route will not be recorded on this device. Use the mobile app for field tracking.';
    case 'background-denied':
      return 'Background location permission was declined, so only your check-in and check-out positions will be recorded.';
    case 'background-unavailable':
    case 'start-failed':
      return 'Background location could not be started on this device. Only your check-in and check-out positions will be recorded.';
    case 'foreground-denied':
      return 'Location permission is required to check in for attendance.';
    default:
      return null;
  }
}
