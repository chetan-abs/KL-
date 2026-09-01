import React from 'react';
import { View, StyleSheet } from 'react-native';

import { useThemeColors } from '../../context/ThemeContext';
import { Cash } from '../../services/endpoints';
import { useApi } from '../../hooks/useApi';
import { rupees } from '../../utils/format';
import { formatDate } from '../../utils/datetime';
import AppText from '../../components/AppText';
import Screen from '../../components/mobile/Screen';
import ScreenHeader from '../../components/mobile/ScreenHeader';
import Card from '../../components/mobile/Card';
import Avatar from '../../components/mobile/Avatar';
import Badge from '../../components/mobile/Badge';
import NoticeBar from '../../components/mobile/NoticeBar';
import AsyncBoundary from '../../components/mobile/AsyncBoundary';

/**
 * 21 — Electrician scheme.
 *
 * The slab ladder is drawn in full, reached rungs included, because the number
 * that changes behaviour is the gap to the next one — an electrician on 34 coils
 * needs to see that 50 is worth ₹90 a coil, not just that they are currently
 * earning ₹65.
 *
 * As with agent commission (05), the reward is recorded against the electrician
 * and never printed on the party's invoice.
 */
export default function SchemeScreen({ role, nav }) {
  const COLORS = useThemeColors();
  const styles = React.useMemo(() => StyleSheet.create({
  slab: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 14, gap: 10 },
  reached: { backgroundColor: COLORS.successRow },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 14, gap: 11 },
  ruled: { borderTopWidth: 1, borderTopColor: COLORS.borderLight },
  body: { flex: 1 },
  meta: { marginTop: 3 },
  window: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderTopWidth: 1,
    borderTopColor: COLORS.borderLight,
    backgroundColor: COLORS.surfaceLight,
  },
}), [COLORS]);
  const { data, loading, error, reload } = useApi(() => Cash.schemes(), []);

  // The first live scheme. More than one at a time is possible but rare, and a
  // picker for the usual case of exactly one is a control nobody needs.
  const scheme = (data?.schemes || [])[0];
  const slabs = scheme?.slabs || [];
  const standings = scheme?.standings || [];

  // A slab counts as reached once somebody has cleared its floor.
  const topQty = Math.max(0, ...standings.map((s) => Number(s.qty)));

  return (
    <Screen
      header={
        <ScreenHeader
          clock="16:00"
          role={role.name}
          title="Scheme"
          subtitle={scheme?.name || (loading ? 'Loading…' : 'No live scheme')}
          badge={scheme ? 'Live' : 'None'}
          badgeTone={scheme ? 'success' : 'onBrand'}
        />
      }
      nav={nav}
    >
      <AsyncBoundary
        loading={loading}
        error={error}
        onRetry={reload}
        empty={!scheme}
        emptyGlyph="🎁"
        emptyText="No scheme is running at the moment."
      >
        <Card title="Slabs" flush>
          {slabs.map((slab, index) => {
            const reached = topQty >= Number(slab.min_qty);
            return (
              <View
                key={slab.id}
                style={[styles.slab, index ? styles.ruled : null, reached ? styles.reached : null]}
              >
                <View style={styles.body}>
                  <AppText weight="bold" size="sm">
                    {`${Number(slab.min_qty)}${slab.max_qty ? ` \u2013 ${Number(slab.max_qty)}` : '+'}`}
                  </AppText>
                  <AppText size="xs" color={COLORS.textSecondary} style={styles.meta}>
                    {slab.reward_note || `${rupees(slab.reward_rate)} each`}
                  </AppText>
                </View>
                <Badge tone={reached ? 'success' : 'neutral'}>{reached ? 'Reached' : 'Locked'}</Badge>
              </View>
            );
          })}
          {scheme ? (
            <View style={styles.window}>
              <AppText size="xs" color={COLORS.textMuted}>
                {`${formatDate(scheme.starts_on)} \u2013 ${formatDate(scheme.ends_on)}`}
              </AppText>
            </View>
          ) : null}
        </Card>

        <Card title={`Standings (${standings.length})`} flush>
          {standings.length ? (
            standings.map((person, index) => (
              <View key={person.id} style={[styles.row, index ? styles.ruled : null]}>
                <Avatar name={person.name} size={38} />
                <View style={styles.body}>
                  <AppText weight="bold" size="sm" numberOfLines={1}>{person.name}</AppText>
                  <AppText size="xs" color={COLORS.textSecondary} style={styles.meta}>
                    {`${person.phone} \u00b7 ${Number(person.qty)} sold`}
                  </AppText>
                </View>
                <AppText weight="bold" size="sm" color={COLORS.success}>
                  {rupees(person.earned)}
                </AppText>
              </View>
            ))
          ) : (
            <View style={styles.window}>
              <AppText size="sm" color={COLORS.textMuted}>Nobody has qualified yet.</AppText>
            </View>
          )}
        </Card>

        <NoticeBar tone="warning">
          {scheme?.note ||
            'Scheme reward is recorded against the electrician, never printed on the party invoice.'}
        </NoticeBar>
      </AsyncBoundary>
    </Screen>
  );
}

