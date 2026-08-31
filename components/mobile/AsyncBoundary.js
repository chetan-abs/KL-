import React from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { COLORS } from '../../constants/colors';
import AppText from '../AppText';
import ActionButton from './ActionButton';

/**
 * The three states a screen has before it has content.
 *
 *   <AsyncBoundary loading={loading} error={error} onRetry={reload}
 *                  empty={!rows.length} emptyText="Nothing waiting.">
 *     …
 *   </AsyncBoundary>
 *
 * Written once because the failure state is the one every screen gets wrong.
 * A silent empty list is indistinguishable from a server that refused the
 * request, and on a field phone those call for opposite reactions: wait, versus
 * find signal. So an error always says what went wrong and always offers the
 * retry — never a bare spinner that stops.
 *
 * `empty` is deliberately the caller's judgement, not a length check here: some
 * screens are empty at zero rows and some are empty only when several lists are
 * all empty at once.
 */
export default function AsyncBoundary({
  loading,
  error,
  onRetry,
  empty,
  emptyText = 'Nothing here yet.',
  emptyGlyph = '—',
  children,
}) {
  if (loading) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator size="large" color={COLORS.brand} />
        <AppText size="sm" color={COLORS.textSecondary} style={styles.note}>
          Loading…
        </AppText>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.centre}>
        <AppText size="xxl" style={styles.glyph}>⚠</AppText>
        <AppText weight="bold" size="md" color={COLORS.text} style={styles.title}>
          Could not load this
        </AppText>
        <AppText size="sm" color={COLORS.textSecondary} style={styles.body}>
          {error}
        </AppText>
        {onRetry ? (
          <ActionButton label="Try again" tone="brand" onPress={onRetry} style={styles.retry} />
        ) : null}
      </View>
    );
  }

  if (empty) {
    return (
      <View style={styles.centre}>
        <AppText size="xxl" color={COLORS.textMuted} style={styles.glyph}>
          {emptyGlyph}
        </AppText>
        <AppText size="sm" color={COLORS.textSecondary} style={styles.body}>
          {emptyText}
        </AppText>
      </View>
    );
  }

  return children;
}

const styles = StyleSheet.create({
  centre: { paddingVertical: 56, paddingHorizontal: 28, alignItems: 'center' },
  glyph: { marginBottom: 10 },
  title: { marginBottom: 5, textAlign: 'center' },
  body: { textAlign: 'center', lineHeight: 20 },
  note: { marginTop: 10 },
  retry: { marginTop: 20, alignSelf: 'stretch' },
});
