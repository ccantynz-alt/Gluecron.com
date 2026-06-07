import React, { useContext, useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { type NativeStackNavigationProp } from '@react-navigation/native-stack';
import { colors } from '../theme/colors';
import { fontSizes, fontWeights } from '../theme/typography';
import { AuthContext } from '../navigation/AuthContext';
import { useUserRepos } from '../hooks/useRepo';
import { RepoCard } from '../components/RepoCard';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { type MainStackParamList } from '../navigation/types';

interface Props {
  navigation: NativeStackNavigationProp<MainStackParamList>;
}

export function DashboardScreen({ navigation }: Props) {
  const { user } = useContext(AuthContext);
  const { repos, loading, error, refresh } = useUserRepos(user?.username ?? null);
  const [refreshing, setRefreshing] = useState(false);

  async function onRefresh() {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }

  const recentRepos = repos.slice(0, 6);
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
      >
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.logoRow}>
            <Text style={styles.logoIcon}>⬡</Text>
            <Text style={styles.logoName}>
              glue<Text style={styles.logoAccent}>cron</Text>
            </Text>
          </View>
          <Text style={styles.greeting}>
            {greeting}, <Text style={styles.username}>{user?.displayName || user?.username}</Text>
          </Text>
          <Text style={styles.subGreeting}>Here's what's happening in your repos.</Text>
        </View>

        {/* Stats row */}
        <View style={styles.statsRow}>
          <View style={styles.statCard}>
            <Text style={styles.statNum}>{repos.length}</Text>
            <Text style={styles.statLabel}>Repos</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statNum}>{repos.reduce((acc, r) => acc + r.starCount, 0)}</Text>
            <Text style={styles.statLabel}>Stars</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statNum}>{repos.reduce((acc, r) => acc + r.issueCount, 0)}</Text>
            <Text style={styles.statLabel}>Issues</Text>
          </View>
        </View>

        {/* Recent Repos */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Recent repositories</Text>
            <TouchableOpacity onPress={() => navigation.navigate('RepoList')} activeOpacity={0.7}>
              <Text style={styles.seeAll}>See all</Text>
            </TouchableOpacity>
          </View>

          {loading && !refreshing ? (
            <LoadingSpinner size="small" />
          ) : recentRepos.length === 0 ? (
            <View style={styles.emptyWrap}>
              <Text style={styles.emptyText}>No repositories yet</Text>
            </View>
          ) : (
            recentRepos.map((repo) => (
              <RepoCard
                key={repo.id}
                repo={repo}
                onPress={() =>
                  navigation.navigate('RepoDetail', {
                    owner: user?.username ?? '',
                    repo: repo.name,
                  })
                }
              />
            ))
          )}
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
  scroll: {
    flex: 1,
  },
  content: {
    padding: 16,
    paddingBottom: 32,
  },
  header: {
    marginBottom: 20,
  },
  logoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 16,
  },
  logoIcon: {
    fontSize: 22,
    color: colors.accent,
  },
  logoName: {
    fontSize: fontSizes.md,
    fontWeight: fontWeights.bold,
    color: colors.text,
  },
  logoAccent: {
    color: colors.accent,
  },
  greeting: {
    fontSize: fontSizes.xl,
    fontWeight: fontWeights.bold,
    color: colors.text,
    marginBottom: 4,
  },
  username: {
    color: colors.accent,
  },
  subGreeting: {
    color: colors.textMuted,
    fontSize: fontSizes.sm,
  },
  statsRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 24,
  },
  statCard: {
    flex: 1,
    backgroundColor: colors.bgSurface,
    borderRadius: 10,
    padding: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  statNum: {
    color: colors.accent,
    fontSize: fontSizes.xl,
    fontWeight: fontWeights.bold,
  },
  statLabel: {
    color: colors.textMuted,
    fontSize: fontSizes.xs,
    marginTop: 2,
  },
  section: {
    marginBottom: 24,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  sectionTitle: {
    color: colors.text,
    fontSize: fontSizes.md,
    fontWeight: fontWeights.semibold,
  },
  seeAll: {
    color: colors.accent,
    fontSize: fontSizes.sm,
  },
  emptyWrap: {
    padding: 20,
    alignItems: 'center',
  },
  emptyText: {
    color: colors.textMuted,
    fontSize: fontSizes.sm,
  },
});
