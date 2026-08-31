import React from 'react';
import { View, StyleSheet } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import AppText from '../components/AppText';
import { COLORS } from '../constants/colors';

/**
 * Placeholder, and honest about it.
 *
 * It used to say "Items will be synced from Tally later", which is wrong twice
 * over: Tally sync is listed under Deliberate exclusions in CLAUDE.md and is not
 * coming, and the item master is not waiting on it — GET/POST/PUT /api/items and
 * the stock-movement ledger behind them are written and working. What is missing
 * is this screen.
 */
export default function ItemMasterScreen() {
  return (
    <View style={styles.container}>
      <MaterialCommunityIcons name="package-variant" size={40} color={COLORS.textMuted} />
      <AppText size="lg" weight="bold" style={styles.title}>Item Master</AppText>
      <AppText size="sm" color={COLORS.textSecondary} style={styles.body}>
        Not built yet. The catalogue API and the stock ledger behind it are in
        place — this screen is the part still to be written.
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
  body: { marginTop: 8, textAlign: 'center', maxWidth: 320, lineHeight: 20 },
});
