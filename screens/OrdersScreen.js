import React from 'react';
import { View, StyleSheet } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { COLORS } from '../constants/colors';
import AppText from '../components/AppText';

/**
 * Placeholder, and honest about it.
 *
 * This screen used to render a search field that filtered nothing, three tabs
 * that switched nothing, the sentence "No pending orders." regardless of how
 * many orders existed, and a button to a new-order form whose SAVE and CREATE
 * ORDER controls had no onPress at all. It made no API call of any kind.
 *
 * The order API on the other side is complete — list, read, create with a
 * server-side price snapshot, status changes that reverse stock. Stating that
 * plainly is better than a screen that looks finished and reports a fact it
 * never checked.
 */
export default function OrdersScreen() {
  return (
    <View style={styles.container}>
      <MaterialCommunityIcons name="clipboard-text-outline" size={40} color={COLORS.textMuted} />
      <AppText size="lg" weight="bold" style={styles.title}>Orders</AppText>
      <AppText size="sm" color={COLORS.textSecondary} style={styles.body}>
        Not built yet. Order taking, the item picker and the order list are the
        next piece of work; the API and the stock ledger behind them are already
        in place.
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  title: { marginTop: 12 },
  body: { marginTop: 8, textAlign: 'center', maxWidth: 340, lineHeight: 20 },
});
