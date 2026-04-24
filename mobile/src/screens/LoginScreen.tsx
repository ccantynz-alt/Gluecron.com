import React, { useState, useCallback } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  ActivityIndicator,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useAuth } from '../hooks/useAuth';
import { colors } from '../theme/colors';

export function LoginScreen(): React.ReactElement {
  const { login, isLoading, error } = useAuth();

  const [host, setHost] = useState('https://gluecron.com');
  const [token, setToken] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const handleConnect = useCallback(async () => {
    setLocalError(null);
    const trimmedHost = host.trim();
    const trimmedToken = token.trim();

    if (!trimmedHost) {
      setLocalError('Host URL is required');
      return;
    }
    if (!trimmedToken) {
      setLocalError('Personal Access Token is required');
      return;
    }
    if (!trimmedToken.startsWith('glc_')) {
      setLocalError('Token must start with glc_');
      return;
    }

    try {
      await login(trimmedHost, trimmedToken);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Login failed');
    }
  }, [host, token, login]);

  const displayError = localError ?? error;

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <StatusBar style="light" />
      <ScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
      >
        {/* Branding */}
        <View style={styles.brandSection}>
          <View style={styles.logoContainer}>
            <Text style={styles.logoText}>⑂</Text>
          </View>
          <Text style={styles.appName}>Gluecron</Text>
          <Text style={styles.tagline}>AI-native code intelligence platform</Text>
        </View>

        {/* Form */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Connect to your instance</Text>

          <View style={styles.formGroup}>
            <Text style={styles.label}>Host URL</Text>
            <TextInput
              style={styles.input}
              value={host}
              onChangeText={setHost}
              placeholder="https://gluecron.com"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              textContentType="URL"
            />
          </View>

          <View style={styles.formGroup}>
            <Text style={styles.label}>Personal Access Token</Text>
            <TextInput
              style={styles.input}
              value={token}
              onChangeText={setToken}
              placeholder="glc_..."
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              textContentType="password"
            />
            <Text style={styles.hint}>
              Generate a token in Settings → Personal Access Tokens on your Gluecron instance.
            </Text>
          </View>

          {displayError !== null && (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{displayError}</Text>
            </View>
          )}

          <TouchableOpacity
            style={[styles.button, isLoading && styles.buttonDisabled]}
            onPress={handleConnect}
            disabled={isLoading}
            activeOpacity={0.8}
          >
            {isLoading ? (
              <ActivityIndicator size="small" color={colors.text} />
            ) : (
              <Text style={styles.buttonText}>Connect</Text>
            )}
          </TouchableOpacity>
        </View>

        {/* Footer */}
        <Text style={styles.footer}>
          gluecron.com — git hosting, AI code review, gate enforcement
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  container: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 48,
    gap: 32,
  },
  brandSection: {
    alignItems: 'center',
    gap: 10,
  },
  logoContainer: {
    width: 72,
    height: 72,
    borderRadius: 18,
    backgroundColor: colors.bgSecondary,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoText: {
    fontSize: 36,
    color: colors.accentBlue,
  },
  appName: {
    fontSize: 28,
    fontWeight: '700',
    color: colors.text,
    letterSpacing: -0.5,
  },
  tagline: {
    fontSize: 14,
    color: colors.textMuted,
    textAlign: 'center',
  },
  card: {
    backgroundColor: colors.bgSecondary,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 20,
    gap: 16,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
    marginBottom: 4,
  },
  formGroup: {
    gap: 6,
  },
  label: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  input: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: colors.text,
  },
  hint: {
    fontSize: 12,
    color: colors.textMuted,
    lineHeight: 16,
  },
  errorBox: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.accentRed,
    borderRadius: 8,
    padding: 12,
  },
  errorText: {
    fontSize: 13,
    color: colors.accentRed,
    lineHeight: 18,
  },
  button: {
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.text,
  },
  footer: {
    fontSize: 12,
    color: colors.textMuted,
    textAlign: 'center',
  },
});
