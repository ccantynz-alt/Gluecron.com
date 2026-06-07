import React, { useContext, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
  TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors } from '../theme/colors';
import { fontSizes, fontWeights } from '../theme/typography';
import { AuthContext } from '../navigation/AuthContext';
import { getBaseUrl, setBaseUrl } from '../api/client';
import { saveHost } from '../store/auth';

const APP_VERSION = '1.0.0';

export function SettingsScreen() {
  const { user, logout } = useContext(AuthContext);
  const [host, setHostState] = useState(getBaseUrl());
  const [editingHost, setEditingHost] = useState(false);

  async function handleLogout() {
    Alert.alert(
      'Sign out',
      'Are you sure you want to sign out?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign out',
          style: 'destructive',
          onPress: async () => {
            await logout();
          },
        },
      ]
    );
  }

  async function handleSaveHost() {
    const trimmed = host.trim().replace(/\/$/, '');
    if (!trimmed) return;
    setBaseUrl(trimmed);
    await saveHost(trimmed);
    setEditingHost(false);
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.content}>
        {/* Title */}
        <Text style={styles.pageTitle}>Settings</Text>

        {/* User profile section */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Account</Text>
          <View style={styles.card}>
            <View style={styles.avatarRow}>
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>
                  {(user?.displayName || user?.username || '?')[0].toUpperCase()}
                </Text>
              </View>
              <View style={styles.userInfo}>
                <Text style={styles.displayName}>{user?.displayName || user?.username}</Text>
                <Text style={styles.username}>@{user?.username}</Text>
                {user?.email && <Text style={styles.email}>{user.email}</Text>}
              </View>
            </View>
            {user?.bio ? (
              <Text style={styles.bio}>{user.bio}</Text>
            ) : null}
          </View>
        </View>

        {/* Host section */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Gluecron Host</Text>
          <View style={styles.card}>
            <View style={styles.hostRow}>
              <Text style={styles.hostLabel}>Server URL</Text>
              {!editingHost ? (
                <View style={styles.hostValueRow}>
                  <Text style={styles.hostValue} numberOfLines={1}>{host}</Text>
                  <TouchableOpacity
                    onPress={() => setEditingHost(true)}
                    style={styles.editBtn}
                    activeOpacity={0.75}
                  >
                    <Text style={styles.editBtnText}>Edit</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <View style={styles.hostEditRow}>
                  <TextInput
                    style={styles.hostInput}
                    value={host}
                    onChangeText={setHostState}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    placeholder="https://gluecron.com"
                    placeholderTextColor={colors.textMuted}
                    returnKeyType="done"
                    onSubmitEditing={handleSaveHost}
                  />
                  <TouchableOpacity onPress={handleSaveHost} style={styles.saveBtn} activeOpacity={0.75}>
                    <Text style={styles.saveBtnText}>Save</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => { setHostState(getBaseUrl()); setEditingHost(false); }}
                    style={styles.cancelBtn}
                    activeOpacity={0.75}
                  >
                    <Text style={styles.cancelBtnText}>Cancel</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
            <Text style={styles.hostHint}>
              Change this if you run a self-hosted Gluecron instance.
            </Text>
          </View>
        </View>

        {/* App info */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>About</Text>
          <View style={styles.card}>
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>App version</Text>
              <Text style={styles.infoValue}>{APP_VERSION}</Text>
            </View>
            <View style={styles.divider} />
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Platform</Text>
              <Text style={styles.infoValue}>Gluecron Mobile</Text>
            </View>
          </View>
        </View>

        {/* Logout */}
        <View style={styles.section}>
          <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout} activeOpacity={0.8}>
            <Text style={styles.logoutText}>Sign out</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, paddingBottom: 40 },
  pageTitle: {
    color: colors.text,
    fontSize: fontSizes.xl,
    fontWeight: fontWeights.bold,
    marginBottom: 20,
  },
  section: { marginBottom: 24 },
  sectionLabel: {
    color: colors.textMuted,
    fontSize: fontSizes.xs,
    fontWeight: fontWeights.semibold,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 8,
  },
  card: {
    backgroundColor: colors.bgSurface,
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
  },
  avatarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginBottom: 8,
  },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.accentDim,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.accent,
  },
  avatarText: {
    color: colors.accent,
    fontSize: fontSizes.xl,
    fontWeight: fontWeights.bold,
  },
  userInfo: { flex: 1 },
  displayName: {
    color: colors.text,
    fontSize: fontSizes.md,
    fontWeight: fontWeights.semibold,
    marginBottom: 2,
  },
  username: { color: colors.textMuted, fontSize: fontSizes.sm, marginBottom: 2 },
  email: { color: colors.textMuted, fontSize: fontSizes.xs },
  bio: { color: colors.textMuted, fontSize: fontSizes.sm, lineHeight: 18, marginTop: 4 },
  hostRow: { marginBottom: 8 },
  hostLabel: { color: colors.textMuted, fontSize: fontSizes.xs, fontWeight: fontWeights.medium, marginBottom: 6, textTransform: 'uppercase' },
  hostValueRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  hostValue: { color: colors.text, fontSize: fontSizes.sm, flex: 1 },
  editBtn: { paddingHorizontal: 10, paddingVertical: 5, backgroundColor: colors.bgSecondary, borderRadius: 6 },
  editBtnText: { color: colors.accent, fontSize: fontSizes.xs, fontWeight: fontWeights.medium },
  hostEditRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  hostInput: {
    flex: 1,
    backgroundColor: colors.bgSecondary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: colors.text,
    fontSize: fontSizes.sm,
    minHeight: 36,
  },
  saveBtn: { paddingHorizontal: 12, paddingVertical: 8, backgroundColor: colors.accent, borderRadius: 6 },
  saveBtnText: { color: colors.white, fontSize: fontSizes.sm, fontWeight: fontWeights.medium },
  cancelBtn: { paddingHorizontal: 10, paddingVertical: 8 },
  cancelBtnText: { color: colors.textMuted, fontSize: fontSizes.sm },
  hostHint: { color: colors.textMuted, fontSize: fontSizes.xs, lineHeight: 16 },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4 },
  infoLabel: { color: colors.textMuted, fontSize: fontSizes.sm },
  infoValue: { color: colors.text, fontSize: fontSizes.sm, fontWeight: fontWeights.medium },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: 8 },
  logoutBtn: {
    backgroundColor: colors.red + '22',
    borderWidth: 1,
    borderColor: colors.red + '55',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  logoutText: { color: colors.red, fontSize: fontSizes.base, fontWeight: fontWeights.semibold },
});
