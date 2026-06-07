import React, { useContext, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  RefreshControl,
  TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { type NativeStackNavigationProp } from '@react-navigation/native-stack';
import { colors } from '../theme/colors';
import { fontSizes, fontWeights } from '../theme/typography';
import { AuthContext } from '../navigation/RootNavigator';
import { useUserRepos } from '../hooks/useRepo';
import { RepoCard } from '../components/RepoCard';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { type MainStackParamList } from '../navigation/MainTabNavigator';

interface Props {
  navigation: NativeStackNavigationProp<MainStackParamList>;
}

export function RepoListScreen({ navigation }: Props) {
  const { user } = useContext(AuthContext);
  const { repos, loading, error, refresh } = useUserRepos(user?.username ?? null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');

  async function onRefresh() {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }

  const filtered = query.trim()
    ? repos.filter(
        (r) =>
          r.name.toLowerCase().includes(query.toLowerCase()) ||
          (r.description && r.description.toLowerCase().includes(query.toLowerCase()))
      )
    : repos;

  if (loading && !refreshing && repos.length === 0) {
    return <LoadingSpinner fullScreen />;
  }

  if (error && repos.length === 0) {
    return <ErrorState message={error} onRetry={refresh} />;
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>Repositories</Text>
        <Text style={styles.count}>{repos.length} repos</Text>
      </View>

      <View style={styles.searchWrap}>
        <TextInput
          style={styles.search}
          value={query}
          onChangeText={setQuery}
          placeholder="Search repositories..."
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
        />
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <RepoCard
            repo={item}
            onPress={() =>
              navigation.navigate('RepoDetail', {
                owner: user?.username ?? '',
                repo: item.name,
              })
            }
          />
        )}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
        }
        ListEmptyComponent={
          <EmptyState
            title={query ? 'No matching repos' : 'No repositories'}
            subtitle={query ? 'Try a different search term' : 'Create your first repo on gluecron.com'}
            icon="⌥"
          />
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
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
  },
  title: {
    color: colors.text,
    fontSize: fontSizes.xl,
    fontWeight: fontWeights.bold,
  },
  count: {
    color: colors.textMuted,
    fontSize: fontSizes.sm,
  },
  searchWrap: {
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  search: {
    backgroundColor: colors.bgSurface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    fontSize: fontSizes.base,
    minHeight: 40,
  },
  list: {
    padding: 16,
    paddingTop: 4,
    paddingBottom: 32,
  },
});
