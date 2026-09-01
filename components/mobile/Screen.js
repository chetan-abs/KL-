import React from 'react';
import { View, ScrollView, StyleSheet } from 'react-native';

import { useThemeColors } from '../../context/ThemeContext';
import { useBreakpoint, CONTENT_MAX_WIDTH } from '../../hooks/useBreakpoint';
import BottomTabBar from './BottomTabBar';
import SideNav from './SideNav';

/**
 * The frame every screen is poured into, in whichever shape the viewport wants.
 *
 *   phone / tablet   header, scrolling body, pinned footer, bottom tab bar
 *   desktop          sidebar on the left; header, body and footer in a column
 *                    beside it, capped and centred
 *
 * Screens do not know which they are in. They pass `nav` through opaquely and
 * this decides — which is why the app could be turned from phone-first to
 * desktop-first without touching any of the thirty-two of them.
 *
 * The footer is pinned in both shapes rather than scrolled with the content.
 * Approve, Reject and Mark Delivered are irreversible and the reader must be
 * able to see the whole decision and the button at once; a footer that scrolls
 * away invites the tap that follows a half-read screen.
 */

/** Kept for the sign-in card, which is capped on every viewport. */
export const PHONE_MAX_WIDTH = 460;

export default function Screen({
  header,
  footer,
  /**
   * `{ tabs, active, onSelect, user, roleTitle, onTab }`.
   *
   * A descriptor rather than a rendered element, because only this component
   * knows whether it becomes a rail or a bar. `onTab` says whether the current
   * screen is a tab's own or one pushed on top: the phone hides the bar for a
   * pushed screen, the desktop keeps the rail either way.
   */
  nav,
  children,
  scroll = true,
  contentStyle,
  refreshControl,
}) {
  const COLORS = useThemeColors();
  const styles = React.useMemo(() => StyleSheet.create({
  flex: { flex: 1 },

  // ---- shared body -------------------------------------------------------
  content: { padding: 14, paddingBottom: 22, gap: 12 },
  contentWide: {
    // Centred by the container's own max width rather than by margins on each
    // card, so a full-bleed row inside a card still reaches both edges.
    width: '100%',
    maxWidth: CONTENT_MAX_WIDTH,
    alignSelf: 'center',
    padding: 22,
    paddingBottom: 40,
    gap: 16,
  },

  // ---- phone / tablet ----------------------------------------------------
  page: { flex: 1, backgroundColor: COLORS.background, alignItems: 'center' },
  frame: {
    flex: 1,
    width: '100%',
    // Tablets get the wider measure without the sidebar; the cap stops a 1024pt
    // iPad rendering a phone column down the middle of the glass.
    maxWidth: 720,
    backgroundColor: COLORS.background,
  },
  footer: {
    padding: 14,
    paddingTop: 12,
    gap: 10,
    backgroundColor: COLORS.surface,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },

  // ---- desktop -----------------------------------------------------------
  deskPage: { flex: 1, flexDirection: 'row', backgroundColor: COLORS.background },
  deskMain: { flex: 1, backgroundColor: COLORS.background },
  deskFooter: {
    backgroundColor: COLORS.surface,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    paddingVertical: 14,
    alignItems: 'center',
  },
  // Padded inside its own max width, matching the header and the content column
  // so all three share one left edge.
  deskFooterInner: {
    width: '100%',
    maxWidth: CONTENT_MAX_WIDTH,
    paddingHorizontal: 22,
    alignItems: 'flex-end',
  },
  deskActions: { width: '100%', maxWidth: 420, gap: 10 },
}), [COLORS]);
  const { hasSidebar } = useBreakpoint();

  const body = scroll ? (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={[
        styles.content,
        hasSidebar ? styles.contentWide : null,
        contentStyle,
      ]}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      // Passed in rather than built here: only the screen knows what it is
      // refreshing, and a list that reloads unasked loses the reader's place.
      refreshControl={refreshControl}
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[styles.flex, styles.content, hasSidebar ? styles.contentWide : null, contentStyle]}>
      {children}
    </View>
  );

  // ---- Desktop: rail beside a capped column -------------------------------
  if (hasSidebar) {
    return (
      <View style={styles.deskPage}>
        {nav ? (
          <SideNav
            tabs={nav.tabs}
            active={nav.active}
            onSelect={nav.onSelect}
            user={nav.user}
            roleTitle={nav.roleTitle}
          />
        ) : null}

        <View style={styles.deskMain}>
          {header}
          {body}
          {footer ? (
            <View style={styles.deskFooter}>
              {/* Actions sit at the right of the content column and are capped
                  well below its width. A confirm button stretched across 900px
                  is a target the cursor has to travel to and reads as a banner
                  rather than a control. */}
              <View style={styles.deskFooterInner}>
                <View style={styles.deskActions}>{footer}</View>
              </View>
            </View>
          ) : null}
        </View>
      </View>
    );
  }

  // ---- Phone and tablet: the original stack -------------------------------
  return (
    <View style={styles.page}>
      <View style={styles.frame}>
        {header}
        {body}
        {footer ? <View style={styles.footer}>{footer}</View> : null}
        {nav?.onTab ? (
          <BottomTabBar tabs={nav.tabs} active={nav.active} onSelect={nav.onSelect} />
        ) : null}
      </View>
    </View>
  );
}


