import React from 'react';
import { View, TouchableOpacity, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useThemeColors } from '../../context/ThemeContext';
import AppText from '../AppText';

/**
 * The four-slot tab bar at the foot of a role's home screens.
 *
 * Tabs come from the signed-in role rather than being fixed, because the roles
 * in this app barely overlap — a driver has no register and a picker has no
 * order queue. `constants/roles.js` owns that mapping; this only draws it.
 *
 * The badge is a count, not a dot: "how many are waiting" is the thing every
 * role opens the app to find out.
 */
export default function BottomTabBar({ tabs = [], active, onSelect }) {
  const COLORS = useThemeColors();
  const styles = React.useMemo(() => StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: COLORS.surface,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    paddingTop: 9,
  },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  label: { marginTop: 3 },
  badge: {
    position: 'absolute',
    top: -4,
    right: -10,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 4,
    backgroundColor: COLORS.error,
    alignItems: 'center',
    justifyContent: 'center',
  },
}), [COLORS]);
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
      {tabs.map((tab) => {
        const on = tab.key === active;
        return (
          <TouchableOpacity
            key={tab.key}
            style={styles.tab}
            onPress={() => onSelect(tab.key)}
            activeOpacity={0.7}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={tab.label}
          >
            <View>
              <MaterialCommunityIcons
                name={tab.icon}
                size={23}
                color={on ? COLORS.brand : COLORS.textMuted}
              />
              {tab.badge ? (
                <View style={styles.badge}>
                  <AppText weight="bold" size={9} color={COLORS.white}>
                    {tab.badge > 99 ? '99+' : tab.badge}
                  </AppText>
                </View>
              ) : null}
            </View>
            <AppText
              weight={on ? 'bold' : 'regular'}
              size={11}
              color={on ? COLORS.brand : COLORS.textMuted}
              style={styles.label}
            >
              {tab.label}
            </AppText>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

