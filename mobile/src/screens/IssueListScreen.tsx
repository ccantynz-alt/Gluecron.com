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
import { useIssues } from '../hooks/useIssues';
import { IssueRow } from '../components/IssueRow';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { type MainStackParamList } from '../navigation/MainTabNavigator';

type Props = {
  navigation: NativeStackNavigationProp<MainStackParamList, 'IssueList'>;
  route: RouteProp<MainStackParamList, 'IssueList'>;
};

export function IssueListScreen({ navigation, route }: Props) {
  const { owner, repo } = route.params;
  const [stateFilter, setStateFilter] = useState<'open' | 'closed'>('open');
  const [refreshing, setRefreshing] = useState(false);
  const { issues, loading, error, refresh } = useIssues(owner, repo, stateFilter);

  async function onRefresh() {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }

  if (loading && !refreshing && issues.length === 0) {
    return <LoadingSpinner fullScreen />;
  }

  if (error && issues.length === 0) {
    return <ErrorState message={error} onRetry={refresh} />;
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {/* State toggle */}
      <View style={styles.toggleBar}>
        <TouchableOpacity
          style={[styles.toggleBtn, stateFilter === 'open' && styles.toggleActive]}
          onPress={() => setStateFilter('open')}
          activeOpacity={0.75}
        >
          <View style={[styles.dot, { backgroundColor: colors.green }]} />
          <Text style={[styles.toggleText, stateFilter === 'open' && styles.toggleTextActive]}>
            Open
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.toggleBtn, stateFilter === 'closed' && styles.toggleActive]}
          onPress={() => setStateFilter('closed')}
          activeOpacity={0.75}
        >
          <View style={[styles.dot, { backgroundColor: colors.textMuted }]} />
          <Text style={[styles.toggleText, stateFilter === 'closed' && styles.toggleTextActive]}>
            Closed
          </Text>
        </TouchableOpacity>
        <Text style={styles.repoBadge}>{owner}/{repo}</Text>
      </View>

      <FlatList
        data={issues}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <IssueRow
            issue={item}
            onPress={() =>
              navigation.navigate('IssueDetail', {
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
            title={`No ${stateFilter} issues`}
            subtitle="Issues will appear here when created"
            icon="●"
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
  toggleBar: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  toggleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  toggleActive: {
    borderColor: colors.border,
    backgroundColor: colors.bgSurface,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  toggleText: {
    color: colors.textMuted,
    fontSize: fontSizes.sm,
    fontWeight: fontWeights.medium,
  },
  toggleTextActive: {
    color: colors.text,
  },
  repoBadge: {
    marginLeft: 'auto',
    color: colors.textMuted,
    fontSize: fontSizes.xs,
  },
});
