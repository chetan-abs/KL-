export const TYPOGRAPHY = {
  fontFamily: {
    light: 'AppFont-Light',
    regular: 'AppFont-Regular',
    medium: 'AppFont-Medium',
    bold: 'AppFont-Bold',
  },
  baseSize: 18,
  size: {
    xs: 12,
    sm: 14,
    md: 16,
    base: 18,
    lg: 20,
    xl: 24,
    xxl: 30,
    huge: 36,
    // Aliases for the names screens were already using. AppText fell back to
    // baseSize (18) for an unknown key, so a dashboard headline figure rendered
    // at the same size as its own caption.
    '2xl': 24,
    '3xl': 30,
  }
};
