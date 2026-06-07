import React, { useState } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  RefreshControl,
  TouchableOpacity,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { type NativeStackNavigationProp } from '@react-navigation/native-stack';
import { type RouteProp } from '@react-navigation/native';
import { colors } from '../theme/colors';
import { fontSizes, fontWeights } from '../theme/typography';
import { usePulls } from '../hooks/usePulls';
import { PullRow } from '../components/PullRow';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { type MainStackParamList } from '../navigation/MainTabNavigator';

type PullState = 'open' | 'closed' | 'merged';

type Props = {
  navigation: NativeStackNavigationProp<MainStackParamList, 'PullList'>;
  route: RouteProp<MainStackParamList, 'PullList'>;
};

const STATE_LABELS: PullState[] = ['open', 'merged', 'closed'];

export function PullListScreen({ navigation, route }: Props) {
  const { owner, repo } = route.params;
  const [stateFilter, setStateFilter] = useState<PullState>('open');
  const [refreshing, setRefreshing] = useState(false);
  const { pulls, loading, error, refresh } = usePulls(owner, repo, stateFilter);

  async function onRefresh() {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }

  if (loading && !refreshing && pulls.length === 0) {
    return <LoadingSpinner fullScreen />;
  }

  if (error && pulls.length === 0) {
    return <ErrorState message={error} onRetry={refresh} />;
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.filterBar}>
        {STATE_LABELS.map((s) => (
          <TouchableOpacity
            key={s}
            style={[styles.filterBtn, stateFilter === s && styles.filterBtnActive]}
            onPress={() => setStateFilter(s)}
            activeOpacity={0.75}
          >
            <Text style={[styles.filterText, stateFilter === s && styles.filterTextActive]}>
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </Text>
          </TouchableOpacity>
        ))}
        <Text style={styles.repoBadge}>{owner}/{repo}</Text>
      </View>

      <FlatList
        data={pulls}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <PullRow
            pull={item}
            onPress={() =>
              navigation.navigate('PullDetail', {
                owner,
                repo,
                number: item.number,
              })
            }
          />
        )}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
        }
        ListEmptyComponent={
          <EmptyState
            title={`No ${stateFilter} pull requests`}
            subtitle="Pull requests will appear here when created"
            icon="⑂"
          />
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  filterBar: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    gap: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    flexWrap: 'wrap',
  },
  filterBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  filterBtnActive: {
    borderColor: colors.border,
    backgroundColor: colors.bgSurface,
  },
  filterText: {
    color: colors.textMuted,
    fontSize: fontSizes.sm,
    fontWeight: fontWeights.medium,
  },
  filterTextActive: {
    color: colors.text,
  },
  repoBadge: {
    marginLeft: 'auto',
    color: colors.textMuted,
    fontSize: fontSizes.xs,
  },
});
