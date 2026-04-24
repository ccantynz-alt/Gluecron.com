import { StyleSheet } from 'react-native';
import { colors } from './colors';

export const typography = StyleSheet.create({
  h1: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.text,
    lineHeight: 32,
  },
  h2: {
    fontSize: 20,
    fontWeight: '600',
    color: colors.text,
    lineHeight: 28,
  },
  h3: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
    lineHeight: 24,
  },
  body: {
    fontSize: 14,
    fontWeight: '400',
    color: colors.text,
    lineHeight: 22,
  },
  bodySmall: {
    fontSize: 12,
    fontWeight: '400',
    color: colors.textMuted,
    lineHeight: 18,
  },
  mono: {
    fontSize: 13,
    fontFamily: 'monospace',
    color: colors.text,
    lineHeight: 20,
  },
  monoSmall: {
    fontSize: 11,
    fontFamily: 'monospace',
    color: colors.textMuted,
    lineHeight: 16,
  },
  label: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.textMuted,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  link: {
    fontSize: 14,
    fontWeight: '400',
    color: colors.textLink,
    lineHeight: 22,
  },
});
