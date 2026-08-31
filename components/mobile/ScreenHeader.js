import React from 'react';
import { View, TouchableOpacity, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { COLORS } from '../../constants/colors';
import { useBreakpoint, CONTENT_MAX_WIDTH } from '../../hooks/useBreakpoint';
import AppText from '../AppText';
import Badge from './Badge';

/**
 * The band at the top of every screen.
 *
 * On a phone it is the navy header from the mockups: status line, back link,
 * title and status pill, carrying the brand because nothing else does.
 *
 * On desktop the sidebar already carries the brand and the signed-in name, so a
 * second navy field would be the same information twice and would cost a
 * hundred pixels of the fold. It becomes a light page header instead — same
 * title, same pill, on the page's own background.
 *
 * The pill stays on the title's baseline in both, rather than up on the status
 * line: it is the state of *this document* — PENDING, VERIFY, EN ROUTE — not a
 * property of the session.
 */
export default function ScreenHeader({
  title,
  subtitle,
  role,
  clock,
  badge,
  badgeTone = 'onBrand',
  onBack,
  backLabel = 'Back',
  /**
   * A secondary control in the header's top-right — "Mark all", and the like.
   * Passed as `{ label, onPress }` rather than as JSX so the header can ink it
   * correctly for the shell it is in: the phone header is navy and needs light
   * text, the desktop header is on the page background and needs dark. Passing
   * a styled element instead meant "Mark all" rendered in the navy-header
   * colour on a white desktop header, all but invisible.
   */
  action,
  right,
}) {
  const insets = useSafeAreaInsets();
  const { hasSidebar } = useBreakpoint();

  // ---- Desktop: a light page header --------------------------------------
  if (hasSidebar) {
    return (
      <View style={[styles.deskHeader, { paddingTop: Math.max(insets.top, 20) }]}>
        <View style={styles.deskInner}>
          {onBack ? (
            <TouchableOpacity
              onPress={onBack}
              style={styles.back}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={`Back to ${backLabel}`}
            >
              <AppText size="sm" color={COLORS.textSecondary}>{`←  ${backLabel}`}</AppText>
            </TouchableOpacity>
          ) : null}

          <View style={styles.titleRow}>
            <View style={styles.titleBlock}>
              <AppText weight="bold" size="xxl" color={COLORS.text} numberOfLines={1}>
                {title}
              </AppText>
              {subtitle ? (
                <AppText size="sm" color={COLORS.textSecondary} style={styles.subtitle}>
                  {subtitle}
                </AppText>
              ) : null}
            </View>
            {action ? (
              <TouchableOpacity
                onPress={action.onPress}
                style={styles.action}
                accessibilityRole="button"
                accessibilityLabel={action.label}
              >
                <AppText weight="bold" size="sm" color={COLORS.primary}>
                  {action.label}
                </AppText>
              </TouchableOpacity>
            ) : null}
            {badge ? (
              <Badge
                tone={badgeTone === 'onBrand' ? 'neutral' : badgeTone}
                style={styles.headerBadge}
              >
                {badge}
              </Badge>
            ) : null}
            {right}
          </View>
        </View>
      </View>
    );
  }

  // ---- Phone and tablet: the navy band -----------------------------------
  return (
    <View style={[styles.header, { paddingTop: Math.max(insets.top, 12) }]}>
      {clock || role ? (
        <View style={styles.statusLine}>
          <AppText weight="bold" size="sm" color={COLORS.white}>
            {clock}
          </AppText>
          {role ? (
            <View style={styles.roleWrap}>
              <AppText weight="medium" size="sm" color={COLORS.white}>
                {role}
              </AppText>
              <View style={styles.dot} />
            </View>
          ) : null}
        </View>
      ) : null}

      {onBack ? (
        <TouchableOpacity
          onPress={onBack}
          style={styles.back}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={`Back to ${backLabel}`}
        >
          <AppText size="sm" color={COLORS.brandMuted}>{`←  ${backLabel}`}</AppText>
        </TouchableOpacity>
      ) : null}

      <View style={styles.titleRow}>
        <View style={styles.titleBlock}>
          <AppText weight="bold" size="xl" color={COLORS.white} numberOfLines={1}>
            {title}
          </AppText>
          {subtitle ? (
            <AppText size="sm" color={COLORS.brandMuted} style={styles.subtitle}>
              {subtitle}
            </AppText>
          ) : null}
        </View>
        {action ? (
          <TouchableOpacity
            onPress={action.onPress}
            style={styles.action}
            accessibilityRole="button"
            accessibilityLabel={action.label}
          >
            <AppText size="xs" color={COLORS.brandMuted}>{action.label}</AppText>
          </TouchableOpacity>
        ) : null}
        {badge ? (
          <Badge tone={badgeTone} style={styles.headerBadge}>{badge}</Badge>
        ) : null}
        {right}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    backgroundColor: COLORS.brand,
    paddingHorizontal: 18,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.headerEdge,
  },
  statusLine: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  roleWrap: { flexDirection: 'row', alignItems: 'center' },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: COLORS.success, marginLeft: 7 },

  deskHeader: {
    backgroundColor: COLORS.background,
    paddingBottom: 18,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    alignItems: 'center',
  },
  // The horizontal padding lives on the inner box, not the outer one, so the
  // title lands on the same vertical as the cards below it — the content column
  // pads inside its own max width, and a header padded outside its own would sit
  // 22px to the left of everything it labels.
  deskInner: { width: '100%', maxWidth: CONTENT_MAX_WIDTH, paddingHorizontal: 22 },

  back: { alignSelf: 'flex-start', paddingVertical: 3, marginBottom: 4 },
  // `gap` rather than relying on space-between alone: with a title, an action
  // and a badge all in the row, space-between alone let the last two touch.
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  action: { paddingVertical: 4, paddingHorizontal: 2 },
  // Badge defaults to `alignSelf: flex-start` so it hugs its content in a
  // column; in this row that floated it above the action beside it.
  headerBadge: { alignSelf: 'center' },
  // Holds the pill against the row's right edge no matter how short the title
  // is; without it a one-word title drags the pill in beside itself.
  titleBlock: { flex: 1, paddingRight: 12 },
  subtitle: { marginTop: 3 },
});
