import React, { useCallback, useEffect, useState } from 'react';
import {
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { listIssues } from '../api/issues';
import type { Issue } from '../api/issues';
import { IssueRow } from '../components/IssueRow';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { ErrorBanner } from '../components/ErrorBanner';
import { colors } from '../theme/colors';
import type { RepoStackParamList } from '../navigation/AppNavigator';

type Props = NativeStackScreenProps<RepoStackParamList, 'Issues'>;
type FilterState = 'open' | 'closed';

export function IssuesScreen({ route, navigation }: Props): React.ReactElement {
  const { owner, repo } = route.params;
  const [filter, setFilter] = useState<FilterState>('open');
  const [issues, setIssues] = useState<Issue[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    listIssues(owner, repo, filter, 1)
      .then((data) => {
        if (!cancelled) {
          setIssues(data);
          setPage(1);
          setHasMore(data.length === 30);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load issues');
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [owner, repo, filter]);

  const loadMore = useCallback(() => {
    if (!hasMore || isLoading) return;
    const nextPage = page + 1;

    listIssues(owner, repo, filter, nextPage)
      .then((data) => {
        setIssues((prev) => [...prev, ...data]);
        setPage(nextPage);
        setHasMore(data.length === 30);
      })
      .catch(() => {/* ignore pagination errors */});
  }, [owner, repo, filter, page, hasMore, isLoading]);

  const handleIssuePress = useCallback(
    (issue: Issue) => {
      navigation.navigate('IssueDetail', { owner, repo, number: issue.number });
    },
    [navigation, owner, repo],
  );

  const renderIssue = useCallback(
    ({ item }: { item: Issue }) => <IssueRow issue={item} onPress={handleIssuePress} />,
    [handleIssuePress],
  );

  const keyExtractor = useCallback((item: Issue) => String(item.id), []);

  const renderFooter = useCallback(
    () => (hasMore ? <LoadingSpinner size="small" /> : null),
    [hasMore],
  );

  if (isLoading && issues.length === 0) return <LoadingSpinner fullScreen />;

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      {/* Filter tabs */}
      <View style={styles.filterTabs}>
        <TouchableOpacity
          style={[styles.filterTab, filter === 'open' && styles.filterTabActive]}
          onPress={() => setFilter('open')}
        >
          <Text style={[styles.filterTabText, filter === 'open' && styles.filterTabTextActive]}>
            Open
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.filterTab, filter === 'closed' && styles.filterTabActive]}
          onPress={() => setFilter('closed')}
        >
          <Text style={[styles.filterTabText, filter === 'closed' && styles.filterTabTextActive]}>
            Closed
          </Text>
        </TouchableOpacity>
      </View>

      {error !== null && <ErrorBanner message={error} />}

      <FlatList
        data={issues}
        keyExtractor={keyExtractor}
        renderItem={renderIssue}
        onEndReached={loadMore}
        onEndReachedThreshold={0.3}
        ListFooterComponent={renderFooter}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>
              No {filter} issues
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
  filterTabs: {
    flexDirection: 'row',
    backgroundColor: colors.bgSecondary,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  filterTab: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  filterTabActive: {
    borderBottomColor: colors.accentBlue,
  },
  filterTabText: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.textMuted,
  },
  filterTabTextActive: {
    color: colors.text,
  },
  list: {
    flex: 1,
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
