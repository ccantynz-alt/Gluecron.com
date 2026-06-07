import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { colors } from '../theme/colors';
import { fontSizes } from '../theme/typography';

interface Props {
  message: string;
  onRetry?: () => void;
}

export function ErrorState({ message, onRetry }: Props) {
  return (
    <View style={styles.container}>
      <Text style={styles.icon}>!</Text>
      <Text style={styles.message}>{message}</Text>
      {onRetry && (
        <TouchableOpacity style={styles.retryBtn} onPress={onRetry} activeOpacity={0.75}>
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    backgroundColor: colors.bg,
  },
  icon: {
    fontSize: 40,
    color: colors.red,
    marginBottom: 12,
    fontWeight: '700',
  },
  message: {
    color: colors.textMuted,
    fontSize: fontSizes.base,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 20,
  },
  retryBtn: {
    backgroundColor: colors.accentDim,
    borderRadius: 8,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  retryText: {
    color: colors.accent,
    fontSize: fontSizes.base,
    fontWeight: '600',
  },
});
