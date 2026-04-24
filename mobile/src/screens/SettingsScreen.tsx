import React, { useCallback, useState } from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../hooks/useAuth';
import { useSettingsStore } from '../store/settingsStore';
import { colors } from '../theme/colors';

export function SettingsScreen(): React.ReactElement {
  const { user, logout } = useAuth();
  const { host, setHost, notificationsEnabled, setNotificationsEnabled } =
    useSettingsStore();

  const [hostInput, setHostInput] = useState(host);
  const [hostSaved, setHostSaved] = useState(false);

  const handleSaveHost = useCallback(() => {
    const trimmed = hostInput.trim().replace(/\/$/, '');
    if (!trimmed) return;
    setHost(trimmed);
    setHostSaved(true);
    setTimeout(() => setHostSaved(false), 2000);
  }, [hostInput, setHost]);

  const handleLogout = useCallback(() => {
    Alert.alert(
      'Sign Out',
      'Are you sure you want to sign out?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign Out',
          style: 'destructive',
          onPress: () => logout(),
        },
      ],
    );
  }, [logout]);

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <ScrollView showsVerticalScrollIndicator={false}>
        {/* Header */}
        <View style={styles.pageHeader}>
          <Text style={styles.pageTitle}>Settings</Text>
        </View>

        {/* Account section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Account</Text>
          <View style={styles.card}>
            <View style={styles.accountRow}>
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>
                  {user?.username.charAt(0).toUpperCase() ?? '?'}
                </Text>
              </View>
              <View style={styles.accountInfo}>
                <Text style={styles.username}>{user?.username ?? 'Unknown'}</Text>
                <Text style={styles.email}>{user?.email ?? ''}</Text>
              </View>
            </View>
          </View>
        </View>

        {/* Connection section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Connection</Text>
          <View style={styles.card}>
            <View style={styles.formGroup}>
              <Text style={styles.label}>Host URL</Text>
              <View style={styles.inputRow}>
                <TextInput
                  style={styles.input}
                  value={hostInput}
                  onChangeText={setHostInput}
                  placeholder="https://gluecron.com"
                  placeholderTextColor={colors.textMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                />
                <TouchableOpacity
                  style={[styles.saveButton, hostSaved && styles.saveButtonSaved]}
                  onPress={handleSaveHost}
                  activeOpacity={0.8}
                >
                  <Text style={styles.saveButtonText}>
                    {hostSaved ? '✓ Saved' : 'Save'}
                  </Text>
                </TouchableOpacity>
              </View>
              <Text style={styles.hint}>
                Current: {host}
              </Text>
            </View>
          </View>
        </View>

        {/* Preferences section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Preferences</Text>
          <View style={styles.card}>
            <View style={styles.toggleRow}>
              <View>
                <Text style={styles.toggleLabel}>Notifications</Text>
                <Text style={styles.toggleDesc}>
                  Show notification badges
                </Text>
              </View>
              <Switch
                value={notificationsEnabled}
                onValueChange={setNotificationsEnabled}
                trackColor={{ false: colors.bgTertiary, true: colors.accent }}
                thumbColor={colors.text}
              />
            </View>
          </View>
        </View>

        {/* About section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>About</Text>
          <View style={styles.card}>
            <View style={styles.aboutRow}>
              <Text style={styles.aboutLabel}>App Version</Text>
              <Text style={styles.aboutValue}>1.0.0</Text>
            </View>
            <View style={[styles.aboutRow, styles.aboutRowBorder]}>
              <Text style={styles.aboutLabel}>Platform</Text>
              <Text style={styles.aboutValue}>Gluecron Mobile</Text>
            </View>
            <View style={[styles.aboutRow, styles.aboutRowBorder]}>
              <Text style={styles.aboutLabel}>Connected to</Text>
              <Text style={styles.aboutValue} numberOfLines={1}>
                {host}
              </Text>
            </View>
          </View>
        </View>

        {/* Danger zone */}
        <View style={styles.section}>
          <TouchableOpacity
            style={styles.logoutButton}
            onPress={handleLogout}
            activeOpacity={0.8}
          >
            <Text style={styles.logoutText}>Sign Out</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.footer}>
          <Text style={styles.footerText}>
            Gluecron — AI-native code intelligence platform
          </Text>
          <Text style={styles.footerText}>gluecron.com</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  pageHeader: {
    paddingHorizontal: 16,
    paddingVertical: 16,
    backgroundColor: colors.bgSecondary,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  pageTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.text,
  },
  section: {
    marginTop: 24,
    paddingHorizontal: 16,
    gap: 8,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  card: {
    backgroundColor: colors.bgSecondary,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  accountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    gap: 12,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.accentBlue,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.bg,
  },
  accountInfo: {
    gap: 3,
  },
  username: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
  },
  email: {
    fontSize: 13,
    color: colors.textMuted,
  },
  formGroup: {
    padding: 14,
    gap: 8,
  },
  label: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  inputRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  input: {
    flex: 1,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: colors.text,
  },
  saveButton: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: colors.bgTertiary,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  saveButtonSaved: {
    borderColor: colors.accent,
  },
  saveButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textLink,
  },
  hint: {
    fontSize: 12,
    color: colors.textMuted,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 14,
  },
  toggleLabel: {
    fontSize: 15,
    fontWeight: '500',
    color: colors.text,
  },
  toggleDesc: {
    fontSize: 12,
    color: colors.textMuted,
    marginTop: 2,
  },
  aboutRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  aboutRowBorder: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  aboutLabel: {
    fontSize: 14,
    color: colors.textMuted,
  },
  aboutValue: {
    fontSize: 14,
    color: colors.text,
    maxWidth: '60%',
    textAlign: 'right',
  },
  logoutButton: {
    backgroundColor: colors.bgSecondary,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.accentRed,
    paddingVertical: 14,
    alignItems: 'center',
  },
  logoutText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.accentRed,
  },
  footer: {
    padding: 32,
    alignItems: 'center',
    gap: 4,
  },
  footerText: {
    fontSize: 12,
    color: colors.textMuted,
    textAlign: 'center',
  },
});
