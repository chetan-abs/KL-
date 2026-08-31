import React from 'react';
import { Text } from 'react-native';
import { TYPOGRAPHY } from '../constants/typography';
import { COLORS } from '../constants/colors';

// A size or weight that does not exist used to resolve to the base size and the
// system font with no complaint, so the mistake was invisible until someone
// noticed the type looked wrong. It still renders — a warning must not break a
// screen — but it says so once, in development only.
function resolve(map, key, fallback, kind) {
  const value = map[key];
  if (value !== undefined) return value;
  if (__DEV__ && key !== undefined) {
    console.warn(`[AppText] unknown ${kind} "${key}" — falling back. Add it to constants/typography.js or use a defined one.`);
  }
  return fallback;
}

const AppText = ({ 
  style, 
  children, 
  weight = 'regular', 
  size = 'base', 
  color,
  ...props 
}) => {
  const textStyle = [
    {
      fontFamily: resolve(TYPOGRAPHY.fontFamily, weight, TYPOGRAPHY.fontFamily.regular, 'weight'),
      fontSize: typeof size === 'number' ? size : resolve(TYPOGRAPHY.size, size, TYPOGRAPHY.baseSize, 'size'),
      color: color || COLORS.text,
    },
    style
  ];

  return (
    <Text style={textStyle} {...props}>
      {children}
    </Text>
  );
};

export default AppText;
