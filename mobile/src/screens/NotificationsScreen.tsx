import React, { useContext, useEffect } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors } from '../theme/colors';
import { fontSizes, fontWeights } from '../theme/typography';
import { AuthContext } from '../navigation/RootNavigator';
import { useUserRepos } from '../hooks/useRepo';
import { useNotifications } from '../hooks/useNotifications';
import { NotifRow } from '../components/NotifRow';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { EmptyState } from '../components/EmptyState';

export function NotificationsScreen() {
  const { user } = useContext(AuthContext);
  const { repos } = useUserRepos(user?.username ?? null);

  const repoRefs = repos.slice(0, 5).map((r) => ({
    owner: user?.username ?? '',
    name: r.name,
  }));

  const { notifications, loading, error, refresh, markAllRead, unreadCount } = useNotifications(repoRefs);

  useEffect(() => {
    if (repos.length > 0) {
      refresh();
    }
  }, [repos.length]);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>
          Notifications{unreadCount > 0 ? ` (${unreadCount})` : ''}
        </Text>
        {unreadCount > 0 && (
          <TouchableOpacity onPress={markAllRead} style={styles.markReadBtn} activeOpacity={0.75}>
            <Text style={styles.markReadText}>Mark all read</Text>
          </TouchableOpacity>
        )}
      </View>

      {loading && notifications.length === 0 ? (
        <LoadingSpinner size="large" />
      ) : (
        <FlatList
          data={notifications}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <NotifRow notification={item} />}
          refreshControl={
            <RefreshControl refreshing={loading} onRefresh={refresh} tintColor={colors.accent} />
          }
          ListEmptyComponent={
            <EmptyState
              title="No notifications"
              subtitle="Activity from your repos will appear here"
              icon="🔔"
            />
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: {
    color: colors.text,
    fontSize: fontSizes.xl,
    fontWeight: fontWeights.bold,
  },
  markReadBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: colors.accentDim,
    borderRadius: 16,
  },
  markReadText: {
    color: colors.accent,
    fontSize: fontSizes.sm,
    fontWeight: fontWeights.medium,
  },
});
