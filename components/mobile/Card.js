import React from 'react';
import { View, StyleSheet } from 'react-native';
import { COLORS } from '../../constants/colors';
import AppText from '../AppText';

/**
 * The white sheet every phone screen is built from.
 *
 * `title` renders the small uppercase section label the mockups put inside the
 * card's top edge (PARTY INFO, ITEMS, PHYSICAL COUNT). It sits on its own tinted
 * strip with a rule under it, so the label belongs to the card rather than
 * floating above it on the page background.
 *
 * `flush` drops the body padding, for cards whose children are full-bleed rows
 * that draw their own dividers.
 */
export default function Card({ title, right, children, flush = false, style, bodyStyle }) {
  return (
    <View style={[styles.card, style]}>
      {title ? (
        <View style={styles.head}>
          <AppText weight="bold" size={11} color={COLORS.textSecondary} style={styles.title}>
            {title}
          </AppText>
          {right}
        </View>
      ) : null}
      <View style={[flush ? null : styles.body, bodyStyle]}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: COLORS.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    overflow: 'hidden',
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: COLORS.surfaceLight,
    paddingHorizontal: 16,
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  title: { letterSpacing: 0.8, textTransform: 'uppercase' },
  body: { padding: 16 },
});
