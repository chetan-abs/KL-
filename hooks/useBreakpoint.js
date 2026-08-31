import { useWindowDimensions } from 'react-native';

/**
 * Which layout the current viewport gets.
 *
 * Three, not a scale: the app has exactly three shells — a phone with a bottom
 * tab bar, a tablet with the same shell at wider measure, and a desktop with a
 * sidebar. A fourth breakpoint would have nothing different to say.
 *
 * Driven by `useWindowDimensions` rather than a media query so it works on all
 * three targets and re-renders when a desktop window is resized or a tablet is
 * rotated — a CSS query would leave the JS-side layout decisions stale.
 */

export const BREAKPOINTS = {
  /** Below this, one column and a bottom tab bar. */
  tablet: 768,
  /** At or above this, a sidebar and a wide content column. */
  desktop: 1024,
};

/**
 * Content column measure on desktop.
 *
 * Capped, but generously: these are working screens on a business monitor, and
 * at 940 a 1080p window spent a third of its width on empty grey. 1440 fills a
 * 1920 display properly while still leaving a margin, and on anything narrower
 * the column simply takes what is there.
 *
 * There is still a cap rather than none at all, because these cards are mostly
 * short label-value rows: run one edge to edge on an ultrawide and the label
 * sits at one end of the desk and its value at the other, with nothing but
 * white between them.
 */
export const CONTENT_MAX_WIDTH = 1440;

/** The sidebar's fixed width on desktop. */
export const SIDEBAR_WIDTH = 232;

export function useBreakpoint() {
  const { width, height } = useWindowDimensions();

  const isDesktop = width >= BREAKPOINTS.desktop;
  const isTablet = width >= BREAKPOINTS.tablet && width < BREAKPOINTS.desktop;
  const isPhone = width < BREAKPOINTS.tablet;

  return {
    width,
    height,
    isPhone,
    isTablet,
    isDesktop,
    /** True where the shell uses a sidebar instead of a bottom tab bar. */
    hasSidebar: isDesktop,
    /** True where there is room to put two cards side by side. */
    canSplit: width >= BREAKPOINTS.tablet,
  };
}
