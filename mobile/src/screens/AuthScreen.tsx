import React, { useState, useContext } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors } from '../theme/colors';
import { fontSizes, fontWeights } from '../theme/typography';
import { AuthContext } from '../navigation/AuthContext';

export function AuthScreen() {
  const { login } = useContext(AuthContext);
  const [token, setToken] = useState('');
  const [host, setHost] = useState('https://gluecron.com');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleLogin() {
    const trimmed = token.trim();
    if (!trimmed) {
      Alert.alert('Error', 'Please enter your Personal Access Token');
      return;
    }
    setLoading(true);
    try {
      await login(trimmed, undefined, host.trim() || 'https://gluecron.com');
    } catch (err) {
      Alert.alert('Login failed', err instanceof Error ? err.message : 'Invalid token');
    } finally {
      setLoading(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.kav}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          {/* Logo */}
          <View style={styles.logoWrap}>
            <Text style={styles.logoIcon}>⬡</Text>
            <Text style={styles.logoText}>
              glue<Text style={styles.logoAccent}>cron</Text>
            </Text>
            <Text style={styles.tagline}>AI-native git hosting</Text>
          </View>

          {/* Card */}
          <View style={styles.card}>
            <Text style={styles.heading}>Sign in</Text>
            <Text style={styles.subheading}>
              Use a Personal Access Token from your Gluecron account settings.
            </Text>

            <View style={styles.field}>
              <Text style={styles.label}>Personal Access Token</Text>
              <TextInput
                style={styles.input}
                value={token}
                onChangeText={setToken}
                placeholder="glc_..."
                placeholderTextColor={colors.textMuted}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="password"
                returnKeyType="done"
                onSubmitEditing={handleLogin}
              />
            </View>

            <TouchableOpacity
              style={styles.advancedToggle}
              onPress={() => setShowAdvanced((v) => !v)}
              activeOpacity={0.7}
            >
              <Text style={styles.advancedToggleText}>
                {showAdvanced ? '− ' : '+ '}Advanced (self-hosted)
              </Text>
            </TouchableOpacity>

            {showAdvanced && (
              <View style={styles.field}>
                <Text style={styles.label}>Gluecron Host URL</Text>
                <TextInput
                  style={styles.input}
                  value={host}
                  onChangeText={setHost}
                  placeholder="https://gluecron.com"
                  placeholderTextColor={colors.textMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                />
              </View>
            )}

            <TouchableOpacity
              style={[styles.loginBtn, loading && styles.loginBtnDisabled]}
              onPress={handleLogin}
              disabled={loading}
              activeOpacity={0.8}
            >
              {loading ? (
                <ActivityIndicator color={colors.white} size="small" />
              ) : (
                <Text style={styles.loginBtnText}>Sign in</Text>
              )}
            </TouchableOpacity>

            <Text style={styles.hint}>
              Generate a token at{' '}
              <Text style={styles.hintLink}>Settings → Tokens</Text>
              {' '}on your Gluecron instance.
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  kav: {
    flex: 1,
  },
  scroll: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  logoWrap: {
    alignItems: 'center',
    marginBottom: 36,
  },
  logoIcon: {
    fontSize: 48,
    color: colors.accent,
    marginBottom: 8,
  },
  logoText: {
    fontSize: fontSizes.xxl,
    fontWeight: fontWeights.bold,
    color: colors.text,
    letterSpacing: -0.5,
  },
  logoAccent: {
    color: colors.accent,
  },
  tagline: {
    color: colors.textMuted,
    fontSize: fontSizes.sm,
    marginTop: 4,
  },
  card: {
    width: '100%',
    maxWidth: 400,
    backgroundColor: colors.bgSurface,
    borderRadius: 14,
    padding: 24,
    borderWidth: 1,
    borderColor: colors.border,
  },
  heading: {
    color: colors.text,
    fontSize: fontSizes.xl,
    fontWeight: fontWeights.bold,
    marginBottom: 6,
  },
  subheading: {
    color: colors.textMuted,
    fontSize: fontSizes.sm,
    lineHeight: 18,
    marginBottom: 22,
  },
  field: {
    marginBottom: 16,
  },
  label: {
    color: colors.textMuted,
    fontSize: fontSizes.xs,
    fontWeight: fontWeights.medium,
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  input: {
    backgroundColor: colors.bgSecondary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: colors.text,
    fontSize: fontSizes.base,
    minHeight: 44,
  },
  advancedToggle: {
    marginBottom: 12,
  },
  advancedToggleText: {
    color: colors.accent,
    fontSize: fontSizes.sm,
  },
  loginBtn: {
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 8,
    minHeight: 48,
    justifyContent: 'center',
  },
  loginBtnDisabled: {
    opacity: 0.6,
  },
  loginBtnText: {
    color: colors.white,
    fontSize: fontSizes.base,
    fontWeight: fontWeights.semibold,
  },
  hint: {
    color: colors.textMuted,
    fontSize: fontSizes.xs,
    textAlign: 'center',
    marginTop: 16,
    lineHeight: 18,
  },
  hintLink: {
    color: colors.accent,
  },
});
