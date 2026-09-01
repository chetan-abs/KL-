/**
 * Premium Modern Lite Theme Palette — and its dark counterpart.
 *
 * Every screen reads colors through `useThemeColors()` (`context/ThemeContext.js`),
 * not this file directly, so a screen's styles recompute when the theme
 * changes rather than freezing at whichever palette was active when the
 * module first loaded. `COLORS` stays exported here, equal to `LIGHT_COLORS`,
 * only as the light-mode source of truth `ThemeContext` reads from.
 */
export const LIGHT_COLORS = {
  // Brand accents
  primary: '#2563EB',         // Deep Ultramarine Blue
  primaryLight: 'rgba(37, 99, 235, 0.1)',
  primaryDark: '#1D4ED8',

  secondary: '#8B5CF6',       // Vibrant Violet
  secondaryLight: 'rgba(139, 92, 246, 0.1)',
  secondaryDark: '#7C3AED',

  accent: '#F59E0B',          // Soft Amber
  accentLight: 'rgba(245, 158, 11, 0.1)',

  // Brand navy. The sign-in banner and its primary action are set in this
  // rather than in `primary` — the banner is a large field of flat colour, and
  // ultramarine at that size reads as a notification rather than a letterhead.
  brand: '#1E3A6B',
  brandDark: '#152A4E',
  brandMuted: 'rgba(255, 255, 255, 0.72)',
  textOnBrand: '#FFFFFF',

  // Background & Surfaces
  background: '#F8FAFC',     // Frosty Light Slate
  surface: '#FFFFFF',        // Pure White Card Surface
  surfaceLight: '#F1F5F9',   // Slightly darker surface for contrast
  card: '#FFFFFF',
  cardHover: '#F1F5F9',

  // Borders & Dividers
  border: '#E2E8F0',         // Soft Light Slate Border
  borderLight: '#F1F5F9',
  divider: '#E2E8F0',

  // Typography
  text: '#0F172A',           // Very dark slate text
  textSecondary: '#475569',  // Medium slate text
  textMuted: '#94A3B8',      // Light muted text
  textOnPrimary: '#FFFFFF',  // White text on primary buttons
  textOnSecondary: '#FFFFFF',

  // Status Colors
  success: '#10B981',        // Emerald
  successLight: 'rgba(16, 185, 129, 0.1)',
  error: '#EF4444',          // Vibrant Red
  errorLight: 'rgba(239, 68, 68, 0.1)',
  errorDark: '#B91C1C',
  warning: '#F59E0B',        // Amber
  warningLight: 'rgba(245, 158, 11, 0.1)',
  warningDark: '#92400E',
  info: '#3B82F6',           // Blue
  infoLight: 'rgba(59, 130, 246, 0.1)',

  // Special Status
  pending: '#F59E0B',
  confirmed: '#10B981',
  completed: '#2563EB',
  cancelled: '#EF4444',

  // Interactive
  disabled: '#E2E8F0',
  disabledText: '#94A3B8',

  white: '#FFFFFF',
  black: '#000000',
  transparent: 'transparent',

  warningSurface: '#FEF3C7',
  warningBorder: '#FDE68A',
  errorSurface: '#FEE2E2',
  errorBorder: '#FECACA',
  successSurface: '#D1FAE5',
  successBorder: '#A7F3D0',
  infoSurface: '#DBEAFE',
  infoBorder: '#BFDBFE',
  violetSurface: '#EDE9FE',
  violetBorder: '#DDD6FE',

  successRow: '#F0FDF4',
  warningRow: '#FFFBEB',
  errorRow: '#FEF2F2',
  infoRow: '#EFF6FF',

  successDark: '#065F46',
  infoDark: '#1E40AF',
  violetDark: '#6D28D9',

  actionApprove: '#22C55E',
  actionApproveDark: '#16A34A',
  actionReject: '#EF4444',
  actionRejectDark: '#DC2626',
  actionNeutral: '#64748B',
  actionNeutralDark: '#475569',
  actionTeal: '#0D9488',
  actionTealDark: '#0F766E',

  avatarPalette: ['#1E3A6B', '#7C3AED', '#DC2626', '#0D9488', '#EA580C', '#2563EB'],

  headerEdge: '#16305C',
};

/**
 * Same 60-odd tokens, dark ground. Brand navy stays close to itself — the
 * header is already a dark flat field in light mode, so a viewer switching
 * themes should still recognise the letterhead. Every tinted *Surface /
 * *Border / *Row token (the warning/error/success/info/violet washes) is a
 * dark, desaturated version of the same hue rather than the light pastel
 * dimmed — a dimmed pastel on a dark page reads as dirty, not calm — and each
 * matching *Dark ink token flips to a LIGHT tint, because that token's whole
 * job is "text readable on its own Surface fill".
 */
export const DARK_COLORS = {
  primary: '#3B82F6',
  primaryLight: 'rgba(59, 130, 246, 0.16)',
  primaryDark: '#2563EB',

  secondary: '#A78BFA',
  secondaryLight: 'rgba(167, 139, 250, 0.16)',
  secondaryDark: '#8B5CF6',

  accent: '#FBBF24',
  accentLight: 'rgba(251, 191, 36, 0.16)',

  brand: '#16305C',
  brandDark: '#0F2140',
  brandMuted: 'rgba(255, 255, 255, 0.72)',
  textOnBrand: '#FFFFFF',

  background: '#0B1220',
  surface: '#161F2E',
  surfaceLight: '#1E293B',
  card: '#161F2E',
  cardHover: '#1E293B',

  border: '#2A3B52',
  borderLight: '#22304A',
  divider: '#2A3B52',

  text: '#F1F5F9',
  textSecondary: '#A9B7CC',
  textMuted: '#6B7B93',
  textOnPrimary: '#FFFFFF',
  textOnSecondary: '#FFFFFF',

  success: '#34D399',
  successLight: 'rgba(52, 211, 153, 0.16)',
  error: '#F87171',
  errorLight: 'rgba(248, 113, 113, 0.16)',
  errorDark: '#FCA5A5',
  warning: '#FBBF24',
  warningLight: 'rgba(251, 191, 36, 0.16)',
  warningDark: '#FDE68A',
  info: '#60A5FA',
  infoLight: 'rgba(96, 165, 250, 0.16)',

  pending: '#FBBF24',
  confirmed: '#34D399',
  completed: '#60A5FA',
  cancelled: '#F87171',

  disabled: '#2A3B52',
  disabledText: '#6B7B93',

  white: '#FFFFFF',
  black: '#000000',
  transparent: 'transparent',

  warningSurface: '#3A2E12',
  warningBorder: '#5C4419',
  errorSurface: '#3A1B1B',
  errorBorder: '#5C2626',
  successSurface: '#123A2C',
  successBorder: '#1B5C43',
  infoSurface: '#132A46',
  infoBorder: '#1E4066',
  violetSurface: '#2A2145',
  violetBorder: '#40336B',

  successRow: '#0F2A20',
  warningRow: '#2E2410',
  errorRow: '#2E1616',
  infoRow: '#101F33',

  successDark: '#6EE7B7',
  infoDark: '#93C5FD',
  violetDark: '#C4B5FD',

  actionApprove: '#22C55E',
  actionApproveDark: '#16A34A',
  actionReject: '#EF4444',
  actionRejectDark: '#DC2626',
  actionNeutral: '#64748B',
  actionNeutralDark: '#94A3B8',
  actionTeal: '#14B8A6',
  actionTealDark: '#0D9488',

  avatarPalette: ['#3B82F6', '#A78BFA', '#F87171', '#2DD4BF', '#FB923C', '#60A5FA'],

  headerEdge: '#0A1830',
};

/** The light palette, kept as `COLORS` for the one place that still needs a
 * static default: `ThemeContext` itself, before it has resolved a theme. */
export const COLORS = LIGHT_COLORS;
