import React, { useCallback, useEffect, useState } from 'react';
import {
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useAuthStore } from '../store/authStore';
import { listUserRepos } from '../api/repos';
import type { Repository } from '../api/repos';
import { RepoCard } from '../components/RepoCard';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { ErrorBanner } from '../components/ErrorBanner';
import { colors } from '../theme/colors';
import type { RepoStackParamList } from '../navigation/AppNavigator';

type Props = NativeStackScreenProps<RepoStackParamList, 'RepoList'>;

export function RepoListScreen({ navigation }: Props): React.ReactElement {
  const user = useAuthStore((s) => s.user);
  const [repos, setRepos] = useState<Repository[]>([]);
  const [filtered, setFiltered] = useState<Repository[]>([]);
  const [query, setQuery] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    listUserRepos(user.username)
      .then((data) => {
        if (!cancelled) {
          setRepos(data);
          setFiltered(data);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load repos');
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [user, tick]);

  useEffect(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      setFiltered(repos);
    } else {
      setFiltered(
        repos.filter(
          (r) =>
            r.name.toLowerCase().includes(q) ||
            (r.description ?? '').toLowerCase().includes(q),
        ),
      );
    }
  }, [query, repos]);

  const retry = useCallback(() => setTick((t) => t + 1), []);

  const handleRepoPress = useCallback(
    (repo: Repository) => {
      navigation.navigate('Repo', { owner: repo.ownerUsername, repo: repo.name });
    },
    [navigation],
  );

  const renderRepo = useCallback(
    ({ item }: { item: Repository }) => (
      <RepoCard repo={item} onPress={handleRepoPress} />
    ),
    [handleRepoPress],
  );

  const keyExtractor = useCallback((item: Repository) => String(item.id), []);

  if (isLoading) return <LoadingSpinner fullScreen />;

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <View style={styles.searchContainer}>
        <TextInput
          style={styles.searchInput}
          value={query}
          onChangeText={setQuery}
          placeholder="Filter repositories..."
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
        />
      </View>

      {error !== null && <ErrorBanner message={error} onRetry={retry} />}

      <FlatList
        data={filtered}
        keyExtractor={keyExtractor}
        renderItem={renderRepo}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>
              {query ? 'No repositories match your filter.' : 'No repositories found.'}
            </Text>
          </View>
        }
        ListHeaderComponent={
          <View style={styles.listHeader}>
            <Text style={styles.listHeaderText}>
              {filtered.length} {filtered.length === 1 ? 'repository' : 'repositories'}
            </Text>
          </View>
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  searchContainer: {
    padding: 12,
    backgroundColor: colors.bgSecondary,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  searchInput: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: colors.text,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingTop: 8,
    paddingBottom: 24,
  },
  listHeader: {
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  listHeaderText: {
    fontSize: 12,
    color: colors.textMuted,
  },
  emptyState: {
    padding: 40,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 14,
    color: colors.textMuted,
    textAlign: 'center',
  },
});
