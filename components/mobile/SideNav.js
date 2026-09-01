import React from 'react';
import { View, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { useThemeColors } from '../../context/ThemeContext';
import { SIDEBAR_WIDTH } from '../../hooks/useBreakpoint';
import AppText from '../AppText';

/**
 * The desktop navigation rail.
 *
 * A bottom tab bar is a thumb control. On a desktop it sits a whole screen away
 * from where the eye and the cursor already are, and it caps navigation at the
 * five slots a thumb can reach — a limit a 1400px window has no reason to
 * inherit. So the same tabs become a vertical list here, with room for every
 * duty the account holds rather than the first five.
 *
 * The letterhead sits at the top because on desktop this is the only fixed
 * chrome; on the phone the navy header carries it instead.
 */
export default function SideNav({ tabs = [], active, onSelect, user, roleTitle }) {
  const COLORS = useThemeColors();
  const styles = React.useMemo(() => StyleSheet.create({
  rail: {
    width: SIDEBAR_WIDTH,
    backgroundColor: COLORS.brand,
    borderRightWidth: 1,
    borderRightColor: COLORS.headerEdge,
  },
  brand: {
    paddingHorizontal: 18,
    paddingBottom: 20,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.headerEdge,
  },
  place: { marginTop: 2 },

  list: { flex: 1 },
  listBody: { paddingVertical: 12, paddingHorizontal: 10, gap: 2 },

  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    paddingVertical: 11,
    paddingHorizontal: 12,
    borderRadius: 9,
  },
  // A lighter wash of the rail rather than a contrasting fill: the selected item
  // should read as raised out of the navy, not pasted onto it.
  itemOn: { backgroundColor: 'rgba(255,255,255,0.14)' },
  label: { flex: 1 },

  badge: {
    minWidth: 20,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 5,
    backgroundColor: COLORS.error,
    alignItems: 'center',
    justifyContent: 'center',
  },

  foot: {
    paddingHorizontal: 18,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: COLORS.headerEdge,
  },
}), [COLORS]);
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.rail, { paddingTop: Math.max(insets.top, 20) }]}>
      <View style={styles.brand}>
        <AppText weight="bold" size="md" color={COLORS.white} numberOfLines={1}>
          K.L. ELECTRICALS
        </AppText>
        <AppText size="xs" color={COLORS.brandMuted} style={styles.place}>
          Lakhtokia, Guwahati
        </AppText>
      </View>

      <ScrollView style={styles.list} contentContainerStyle={styles.listBody} showsVerticalScrollIndicator={false}>
        {tabs.map((tab) => {
          const on = tab.key === active;
          return (
            <TouchableOpacity
              key={tab.key}
              style={[styles.item, on ? styles.itemOn : null]}
              onPress={() => onSelect(tab.key)}
              activeOpacity={0.75}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              accessibilityLabel={tab.label}
            >
              <MaterialCommunityIcons
                name={tab.icon}
                size={19}
                color={on ? COLORS.white : COLORS.brandMuted}
              />
              <AppText
                weight={on ? 'bold' : 'regular'}
                size="sm"
                color={on ? COLORS.white : COLORS.brandMuted}
                style={styles.label}
                numberOfLines={1}
              >
                {tab.label}
              </AppText>
              {tab.badge ? (
                <View style={styles.badge}>
                  <AppText weight="bold" size={10} color={COLORS.white}>
                    {tab.badge > 99 ? '99+' : tab.badge}
                  </AppText>
                </View>
              ) : null}
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {user ? (
        <View style={[styles.foot, { paddingBottom: Math.max(insets.bottom, 16) }]}>
          <AppText weight="bold" size="sm" color={COLORS.white} numberOfLines={1}>
            {user.name}
          </AppText>
          <AppText size="xs" color={COLORS.brandMuted} numberOfLines={1}>
            {roleTitle}
          </AppText>
        </View>
      ) : null}
    </View>
  );
}

