import React from 'react';
import { ActivityIndicator, View, StyleSheet } from 'react-native';
import { colors } from '../theme/colors';

interface Props {
  size?: 'small' | 'large';
  fullScreen?: boolean;
}

export function LoadingSpinner({ size = 'large', fullScreen = false }: Props) {
  if (fullScreen) {
    return (
      <View style={styles.fullScreen}>
        <ActivityIndicator size={size} color={colors.accent} />
      </View>
    );
  }
  return (
    <View style={styles.inline}>
      <ActivityIndicator size={size} color={colors.accent} />
    </View>
  );
}

const styles = StyleSheet.create({
  fullScreen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
  },
  inline: {
    padding: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
