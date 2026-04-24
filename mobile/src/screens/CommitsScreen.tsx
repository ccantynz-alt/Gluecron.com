import React, { useCallback } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCommits } from '../hooks/useRepo';
import { CommitRow } from '../components/CommitRow';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { ErrorBanner } from '../components/ErrorBanner';
import { colors } from '../theme/colors';
import type { RepoStackParamList } from '../navigation/AppNavigator';
import type { CommitEntry } from '../api/repos';

type Props = NativeStackScreenProps<RepoStackParamList, 'Commits'>;

export function CommitsScreen({ route }: Props): React.ReactElement {
  const { owner, repo, branch } = route.params;
  const { commits, isLoading, error, loadMore, hasMore } = useCommits(
    owner,
    repo,
    branch ?? 'HEAD',
  );

  const renderCommit = useCallback(
    ({ item }: { item: CommitEntry }) => <CommitRow commit={item} />,
    [],
  );

  const keyExtractor = useCallback((item: CommitEntry) => item.sha, []);

  const renderFooter = useCallback(() => {
    if (!hasMore) return null;
    return <LoadingSpinner size="small" />;
  }, [hasMore]);

  if (isLoading && commits.length === 0) return <LoadingSpinner fullScreen />;

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      {error !== null && <ErrorBanner message={error} />}
      <FlatList
        data={commits}
        keyExtractor={keyExtractor}
        renderItem={renderCommit}
        onEndReached={loadMore}
        onEndReachedThreshold={0.3}
        ListFooterComponent={renderFooter}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>No commits found</Text>
          </View>
        }
        ListHeaderComponent={
          <View style={styles.header}>
            <Text style={styles.headerText}>
              {branch ?? 'HEAD'} — commit history
            </Text>
          </View>
        }
        style={styles.list}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  list: {
    flex: 1,
  },
  header: {
    padding: 12,
    backgroundColor: colors.bgTertiary,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerText: {
    fontSize: 12,
    fontFamily: 'monospace',
    color: colors.textMuted,
  },
  emptyState: {
    padding: 40,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 14,
    color: colors.textMuted,
  },
});
