import React, { useCallback, useEffect, useState } from 'react';
import {
  FlatList,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import { useAuthStore } from '../store/authStore';
import { listUserRepos } from '../api/repos';
import { getNotificationCounts } from '../api/notifications';
import type { Repository } from '../api/repos';
import { RepoCard } from '../components/RepoCard';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { ErrorBanner } from '../components/ErrorBanner';
import { colors } from '../theme/colors';
import type { MainTabParamList } from '../navigation/AppNavigator';

type Props = BottomTabScreenProps<MainTabParamList, 'Dashboard'>;

export function DashboardScreen({ navigation }: Props): React.ReactElement {
  const user = useAuthStore((s) => s.user);
  const [repos, setRepos] = useState<Repository[]>([]);
  const [notifCount, setNotifCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const greenCount = repos.filter((r) => r.openIssueCount === 0).length;

  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    setIsLoading(true);
    setError(null);

    Promise.all([
      listUserRepos(user.username),
      getNotificationCounts().catch(() => ({ total: 0, unread: 0 })),
    ])
      .then(([repoList, counts]) => {
        if (!cancelled) {
          setRepos(repoList.slice(0, 10));
          setNotifCount(counts.unread);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load dashboard');
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [user, tick]);

  const retry = useCallback(() => setTick((t) => t + 1), []);

  const handleRepoPress = useCallback(
    (repo: Repository) => {
      (navigation as any).navigate('Repos', {
        screen: 'Repo',
        params: { owner: repo.ownerUsername, repo: repo.name },
      });
    },
    [navigation],
  );

  const navigateNotifications = useCallback(() => {
    (navigation as any).navigate('Notifications');
  }, [navigation]);

  const navigateAskAI = useCallback(() => {
    (navigation as any).navigate('AskAI');
  }, [navigation]);

  const renderRepo = useCallback(
    ({ item }: { item: Repository }) => (
      <RepoCard repo={item} onPress={handleRepoPress} />
    ),
    [handleRepoPress],
  );

  const keyExtractor = useCallback((item: Repository) => String(item.id), []);

  if (isLoading) return <LoadingSpinner fullScreen />;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <StatusBar style="light" />

      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.greeting}>
            Hello, {user?.username ?? 'there'} 👋
          </Text>
          <Text style={styles.subtitle}>Your Gluecron dashboard</Text>
        </View>
        <TouchableOpacity style={styles.notifButton} onPress={navigateNotifications}>
          <Text style={styles.notifIcon}>🔔</Text>
          {notifCount > 0 && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>
                {notifCount > 99 ? '99+' : String(notifCount)}
              </Text>
            </View>
          )}
        </TouchableOpacity>
      </View>

      {error !== null && <ErrorBanner message={error} onRetry={retry} />}

      <ScrollView style={styles.flex} showsVerticalScrollIndicator={false}>
        {/* Stats row */}
        <View style={styles.statsRow}>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>{repos.length}</Text>
            <Text style={styles.statLabel}>Repositories</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={[styles.statValue, { color: colors.accent }]}>{greenCount}</Text>
            <Text style={styles.statLabel}>Gates Green</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={[styles.statValue, { color: colors.accentRed }]}>
              {repos.length - greenCount}
            </Text>
            <Text style={styles.statLabel}>Need Attention</Text>
          </View>
        </View>

        {/* Recent repos */}
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Recent Repositories</Text>
          <TouchableOpacity
            onPress={() => (navigation as any).navigate('Repos')}
          >
            <Text style={styles.seeAll}>See all</Text>
          </TouchableOpacity>
        </View>

        <FlatList
          data={repos}
          keyExtractor={keyExtractor}
          renderItem={renderRepo}
          scrollEnabled={false}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Text style={styles.emptyText}>No repositories yet</Text>
            </View>
          }
        />

        {/* Spacer for FAB */}
        <View style={styles.fabSpacer} />
      </ScrollView>

      {/* Ask AI FAB */}
      <TouchableOpacity style={styles.fab} onPress={navigateAskAI} activeOpacity={0.85}>
        <Text style={styles.fabIcon}>✦</Text>
        <Text style={styles.fabText}>Ask AI</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  flex: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.bgSecondary,
  },
  greeting: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.text,
  },
  subtitle: {
    fontSize: 13,
    color: colors.textMuted,
    marginTop: 2,
  },
  notifButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  notifIcon: {
    fontSize: 22,
  },
  badge: {
    position: 'absolute',
    top: 4,
    right: 4,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: colors.accentRed,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.text,
  },
  statsRow: {
    flexDirection: 'row',
    padding: 16,
    gap: 12,
  },
  statCard: {
    flex: 1,
    backgroundColor: colors.bgSecondary,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    alignItems: 'center',
    gap: 4,
  },
  statValue: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.text,
  },
  statLabel: {
    fontSize: 11,
    color: colors.textMuted,
    textAlign: 'center',
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 8,
    paddingTop: 4,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  seeAll: {
    fontSize: 13,
    color: colors.textLink,
  },
  emptyState: {
    padding: 32,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 14,
    color: colors.textMuted,
  },
  fabSpacer: {
    height: 80,
  },
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 20,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.accentPurple,
    borderRadius: 28,
    paddingHorizontal: 20,
    paddingVertical: 14,
    gap: 8,
    shadowColor: colors.accentPurple,
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  fabIcon: {
    fontSize: 16,
    color: colors.bg,
    fontWeight: '700',
  },
  fabText: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.bg,
  },
});
