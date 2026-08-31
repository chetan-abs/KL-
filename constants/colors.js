/**
 * Premium Modern Lite Theme Palette
 * Concept: Crisp Frost & Ultramarine with Elegant Glassmorphic Hints
 */
export const COLORS = {
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
  // TextField renders validation text in this. It was referenced but never
  // defined, so AppText fell back to the default body colour and an error
  // message read as ordinary help text.
  errorDark: '#B91C1C',
  warning: '#F59E0B',        // Amber
  warningLight: 'rgba(245, 158, 11, 0.1)',
  // Notice renders warning text in this. Amber on a pale amber wash does not
  // reach a readable contrast, which is why the tone needs a darker ink than
  // the rule beside it.
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

  // ---------------------------------------------------------------------------
  // Mobile UI tokens
  //
  // Derived from the July 2026 phone mockups. The tokens above describe the
  // older web admin panel, where tone washes are alpha over a white page. The
  // phone screens stack a tinted row inside a white card inside a grey page, and
  // alpha compounds across those layers — a 10% amber over a card over the page
  // does not render as the same fill twice. These are the opaque equivalents,
  // sampled from the mockups, so a tint reads identically wherever it lands.
  // ---------------------------------------------------------------------------

  // Solid tone washes for notice strips and tinted list rows.
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

  // Faint row tints for the picker and verify sheets, where a whole row is
  // tinted behind text rather than a small badge. One step lighter than the
  // surfaces above so body text keeps its contrast.
  successRow: '#F0FDF4',
  warningRow: '#FFFBEB',
  errorRow: '#FEF2F2',
  infoRow: '#EFF6FF',

  // Ink for text set on the matching *Surface / *Row fills.
  successDark: '#065F46',
  infoDark: '#1E40AF',
  violetDark: '#6D28D9',

  // Action buttons. `success` above is the emerald used for status dots and
  // figures; the approve/deliver buttons in the mockups are a heavier green that
  // holds white text at 56px tall, and the save action is teal, not green.
  actionApprove: '#22C55E',
  actionApproveDark: '#16A34A',
  actionReject: '#EF4444',
  actionRejectDark: '#DC2626',
  actionNeutral: '#64748B',
  actionNeutralDark: '#475569',
  actionTeal: '#0D9488',
  actionTealDark: '#0F766E',

  // Avatar circles in the order queue, cycled by party name.
  avatarPalette: ['#1E3A6B', '#7C3AED', '#DC2626', '#0D9488', '#EA580C', '#2563EB'],

  // The phone status bar and header sit on brand navy; this is the hairline
  // under the header where it meets the page.
  headerEdge: '#16305C',
};
