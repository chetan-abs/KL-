import React, { useState, useEffect } from 'react';
import {
  View,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  Platform
} from 'react-native';
import * as Location from 'expo-location';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { COLORS } from '../constants/colors';
import AppText from '../components/AppText';
import Button from '../components/Button';
import Notice from '../components/Notice';
import api, { describeError } from '../services/api';
import {
  requestLocationPermissions,
  getCurrentLocation,
  startLocationTracking,
  describeTrackingState,
} from '../utils/location';
import { confirmAction, showAlert } from '../services/confirm';

export default function CheckinGateScreen({ onCheckinSuccess, onSignOut }) {
  // States
  const [time, setTime] = useState(new Date());
  const [loc, setLoc] = useState(null);
  const [locName, setLocName] = useState('');
  const [locError, setLocError] = useState('');
  const [fetchingLoc, setFetchingLoc] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  // Update clock every second
  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Fetch coordinates on mount
  const fetchCoords = async () => {
    setFetchingLoc(true);
    setLocError('');
    setLocName('');
    try {
      const permission = await requestLocationPermissions();
      if (!permission.granted) {
        setLocError(describeTrackingState('foreground-denied'));
        setLoc(null);
        return;
      }

      const coords = await getCurrentLocation();
      setLoc(coords);

      // Reverse geocoding is done on the device, by the platform. The web build
      // used to POST the employee's exact position to a public Nominatim
      // endpoint on every check-in — an identified person's location leaving
      // the company to a third party with no consent step. A place name is a
      // convenience; it is not worth that.
      if (Platform.OS !== 'web') {
        try {
          const geocoded = await Location.reverseGeocodeAsync({
            latitude: coords.latitude,
            longitude: coords.longitude,
          });
          const place = geocoded?.[0];
          if (place) {
            setLocName(
              `${place.name || place.street || ''}, ${place.city || ''}`
                .replace(/^,\s*/, '')
                .replace(/,\s*$/, '')
            );
          }
        } catch (geocodeErr) {
          // A missing street name changes nothing about the fix itself.
          console.warn('[Checkin] Reverse geocoding failed:', geocodeErr?.message);
        }
      }
    } catch (e) {
      // The fix genuinely failed. It used to be replaced with Mumbai's
      // coordinates and presented as "GPS Fixed ✓".
      setLocError('Could not get a GPS fix. Move somewhere with a clearer view of the sky and try again.');
      setLoc(null);
    } finally {
      setFetchingLoc(false);
    }
  };

  useEffect(() => {
    fetchCoords();
  }, []);

  // Handle Check-in submit
  const handleCheckin = async () => {
    if (!loc) {
      showAlert('Location needed', 'Wait for your GPS coordinates to be resolved.');
      return;
    }
    setSubmitting(true);
    try {
      await api.post('/attendance/checkin', {
        latitude: loc.latitude,
        longitude: loc.longitude
      });

      const tracking = await startLocationTracking();
      const caveat = tracking.started ? null : describeTrackingState(tracking.reason);
      showAlert(
        'Checked In',
        caveat
          ? `Shift started. ${caveat}`
          : 'Shift started. Your location is recorded while you are checked in.'
      );

      onCheckinSuccess();
    } catch (err) {
      showAlert('Check-In Failed', describeError(err));
    } finally {
      setSubmitting(false);
    }
  };

  // The way out. Without it, anyone who could not get a fix — or who had
  // declined the permission — was held behind an undismissable modal with a
  // button that could not succeed.
  const handleSignOut = () => {
    confirmAction('Sign out', 'You can sign in again later to start your shift.', onSignOut);
  };

  const formattedTime = time.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
  const formattedDate = time.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  return (
    <View style={styles.container}>
      <View style={styles.scrollContent}>

        {/* Visual Header */}
        <View style={styles.header}>
          <View style={styles.iconCircle}>
            <MaterialCommunityIcons name="map-marker-account" size={32} color={COLORS.primary} />
          </View>
          <AppText weight="bold" size="xl" color={COLORS.text} style={styles.title}>
            Check In to Continue
          </AppText>
          <AppText size="sm" color={COLORS.textSecondary} style={styles.subtitle}>
            Your live location will be recorded to mark your shift attendance.
          </AppText>
        </View>

        {/* Digital Clock */}
        <View style={styles.clockCard}>
          <AppText weight="bold" size="huge" color={COLORS.text} style={styles.timeText}>
            {formattedTime}
          </AppText>
          <AppText size="sm" color={COLORS.textSecondary} style={{ marginTop: 4 }}>
            {formattedDate}
          </AppText>
        </View>

        {/* GPS location status panel */}
        <View style={styles.gpsCard}>
          <View style={styles.gpsRow}>
            <MaterialCommunityIcons
              name={loc ? "crosshairs-gps" : "gps-not-fixed"}
              size={20}
              color={loc ? COLORS.success : COLORS.warning}
            />
            <AppText weight="bold" size="sm" color={COLORS.text} style={{ marginLeft: 8 }}>
              Device GPS Status
            </AppText>
          </View>

          <View style={styles.gpsBody}>
            {fetchingLoc ? (
              <View style={styles.fetchingRow}>
                <ActivityIndicator size="small" color={COLORS.primary} style={{ marginRight: 8 }} />
                <AppText size="sm" color={COLORS.textSecondary}>Resolving coordinates...</AppText>
              </View>
            ) : locError ? (
              <View>
                <Notice tone="error">{locError}</Notice>
                <TouchableOpacity style={styles.retryBtn} onPress={fetchCoords}>
                  <MaterialCommunityIcons name="refresh" size={14} color={COLORS.primary} />
                  <AppText size="xs" weight="bold" color={COLORS.primary} style={{ marginLeft: 4 }}>
                    Retry Geolocation
                  </AppText>
                </TouchableOpacity>
              </View>
            ) : loc ? (
              <View>
                <View style={styles.successBadge}>
                  <AppText size="xs" weight="bold" color={COLORS.success}>GPS Fixed ✓</AppText>
                </View>
                <AppText weight="bold" size="sm" color={COLORS.text} style={{ marginTop: 6 }}>
                  {locName || `${loc.latitude.toFixed(5)}, ${loc.longitude.toFixed(5)}`}
                </AppText>
                {loc.accuracy ? (
                  <AppText size="xs" color={COLORS.textMuted} style={{ marginTop: 4 }}>
                    Accuracy error margin: ±{Math.round(loc.accuracy)} meters
                  </AppText>
                ) : null}
              </View>
            ) : (
              <AppText size="sm" color={COLORS.textSecondary}>
                Waiting for geolocation coordinates...
              </AppText>
            )}
          </View>
        </View>

      </View>

      {/* Check In Action Button */}
      <View style={styles.footer}>
        <Button
          variant="brand"
          label="Check-In"
          loadingLabel="Checking In..."
          loading={submitting}
          disabled={!loc || fetchingLoc}
          onPress={handleCheckin}
          style={styles.checkinBtn}
        />

        <TouchableOpacity
          onPress={handleSignOut}
          style={styles.signOutBtn}
          accessibilityRole="button"
          accessibilityLabel="Sign out"
        >
          <MaterialCommunityIcons name="logout" size={16} color={COLORS.textSecondary} />
          <AppText size="xs" weight="bold" color={COLORS.textSecondary} style={{ marginLeft: 6 }}>
            Sign out instead
          </AppText>
        </TouchableOpacity>
      </View>

    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: COLORS.background,
    borderRadius: 16,
    overflow: 'hidden',
    maxHeight: '90%',
    width: '100%',
    maxWidth: 400,
    alignSelf: 'center'
  },
  scrollContent: {
    padding: 20,
    alignItems: 'center'
  },
  header: {
    alignItems: 'center',
    marginVertical: 20
  },
  iconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: COLORS.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16
  },
  title: {
    textAlign: 'center',
    marginBottom: 8
  },
  subtitle: {
    textAlign: 'center',
    paddingHorizontal: 16,
    lineHeight: 18
  },
  clockCard: {
    backgroundColor: COLORS.surface,
    borderRadius: 20,
    paddingVertical: 24,
    paddingHorizontal: 32,
    alignItems: 'center',
    width: '100%',
    borderWidth: 1,
    borderColor: COLORS.border,
    shadowColor: COLORS.black,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.03,
    shadowRadius: 12,
    elevation: 3,
    marginBottom: 20
  },
  timeText: {
    letterSpacing: 1
  },
  gpsCard: {
    backgroundColor: COLORS.surface,
    borderRadius: 20,
    padding: 20,
    width: '100%',
    borderWidth: 1,
    borderColor: COLORS.border,
    shadowColor: COLORS.black,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.03,
    shadowRadius: 12,
    elevation: 3
  },
  gpsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    paddingBottom: 12,
    marginBottom: 12
  },
  gpsBody: {
    minHeight: 60,
    justifyContent: 'center'
  },
  fetchingRow: {
    flexDirection: 'row',
    alignItems: 'center'
  },
  successBadge: {
    alignSelf: 'flex-start',
    backgroundColor: COLORS.successLight,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    marginBottom: 4
  },
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
    alignSelf: 'flex-start',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.primary
  },
  footer: {
    paddingHorizontal: 20,
    paddingBottom: 20,
    marginTop: 'auto'
  },
  checkinBtn: {
    width: '100%'
  },
  signOutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    marginTop: 16,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
});
