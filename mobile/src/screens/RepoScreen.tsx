import React, { useCallback } from 'react';
import {
  FlatList,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useRepo, useTree } from '../hooks/useRepo';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { ErrorBanner } from '../components/ErrorBanner';
import { colors } from '../theme/colors';
import type { RepoStackParamList } from '../navigation/AppNavigator';
import type { TreeEntry } from '../api/repos';

type Props = NativeStackScreenProps<RepoStackParamList, 'Repo'>;

function FileRow({
  entry,
  onPress,
}: {
  entry: TreeEntry;
  onPress: (entry: TreeEntry) => void;
}): React.ReactElement {
  const handlePress = useCallback(() => onPress(entry), [entry, onPress]);
  const icon = entry.type === 'tree' ? '📁' : '📄';

  return (
    <TouchableOpacity style={styles.fileRow} onPress={handlePress} activeOpacity={0.75}>
      <Text style={styles.fileIcon}>{icon}</Text>
      <Text style={styles.fileName} numberOfLines={1}>
        {entry.name}
      </Text>
      {entry.type === 'tree' && <Text style={styles.chevron}>›</Text>}
    </TouchableOpacity>
  );
}

export function RepoScreen({ route, navigation }: Props): React.ReactElement {
  const { owner, repo: repoName } = route.params;
  const { repo, isLoading: repoLoading, error: repoError, refresh: refreshRepo } = useRepo(owner, repoName);
  const {
    entries,
    isLoading: treeLoading,
    error: treeError,
    refresh: refreshTree,
  } = useTree(owner, repoName, repo?.defaultBranch ?? 'HEAD', '');

  const isLoading = repoLoading || treeLoading;
  const error = repoError ?? treeError;
  const refresh = useCallback(() => {
    refreshRepo();
    refreshTree();
  }, [refreshRepo, refreshTree]);

  const handleEntryPress = useCallback(
    (entry: TreeEntry) => {
      if (entry.type === 'tree') {
        navigation.navigate('FileViewer', {
          owner,
          repo: repoName,
          ref: repo?.defaultBranch ?? 'HEAD',
          path: entry.path,
        });
      } else {
        navigation.navigate('FileViewer', {
          owner,
          repo: repoName,
          ref: repo?.defaultBranch ?? 'HEAD',
          path: entry.path,
        });
      }
    },
    [navigation, owner, repoName, repo],
  );

  const renderEntry = useCallback(
    ({ item }: { item: TreeEntry }) => (
      <FileRow entry={item} onPress={handleEntryPress} />
    ),
    [handleEntryPress],
  );

  const keyExtractor = useCallback((item: TreeEntry) => item.path, []);

  if (isLoading) return <LoadingSpinner fullScreen />;

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView showsVerticalScrollIndicator={false}>
        {error !== null && <ErrorBanner message={error} onRetry={refresh} />}

        {repo !== null && (
          <>
            {/* Repo overview card */}
            <View style={styles.overviewCard}>
              {repo.description !== null && repo.description.length > 0 && (
                <Text style={styles.description}>{repo.description}</Text>
              )}
              <View style={styles.metaRow}>
                {repo.language !== null && (
                  <View style={styles.metaItem}>
                    <View style={styles.langDot} />
                    <Text style={styles.metaText}>{repo.language}</Text>
                  </View>
                )}
                <View style={styles.metaItem}>
                  <Text style={styles.metaIcon}>★</Text>
                  <Text style={styles.metaText}>{repo.starCount}</Text>
                </View>
                <View style={styles.metaItem}>
                  <Text style={styles.metaIcon}>⑂</Text>
                  <Text style={styles.metaText}>{repo.forkCount}</Text>
                </View>
              </View>
              <View style={styles.branchRow}>
                <Text style={styles.branchIcon}>⑂</Text>
                <Text style={styles.branchText}>{repo.defaultBranch}</Text>
              </View>
            </View>

            {/* Quick nav */}
            <View style={styles.quickNav}>
              <TouchableOpacity
                style={styles.navButton}
                onPress={() => navigation.navigate('Commits', { owner, repo: repoName })}
              >
                <Text style={styles.navIcon}>◎</Text>
                <Text style={styles.navLabel}>Commits</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.navButton}
                onPress={() => navigation.navigate('Issues', { owner, repo: repoName })}
              >
                <Text style={styles.navIcon}>○</Text>
                <Text style={styles.navLabel}>Issues</Text>
                {repo.openIssueCount > 0 && (
                  <View style={styles.countBadge}>
                    <Text style={styles.countText}>{repo.openIssueCount}</Text>
                  </View>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.navButton}
                onPress={() => navigation.navigate('Pulls', { owner, repo: repoName })}
              >
                <Text style={styles.navIcon}>⑂</Text>
                <Text style={styles.navLabel}>PRs</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.navButton}
                onPress={() => navigation.navigate('GateStatus', { owner, repo: repoName })}
              >
                <Text style={styles.navIcon}>⚡</Text>
                <Text style={styles.navLabel}>Gates</Text>
              </TouchableOpacity>
            </View>
          </>
        )}

        {/* File tree */}
        <View style={styles.treeSection}>
          <View style={styles.treeSectionHeader}>
            <Text style={styles.treeSectionTitle}>Files</Text>
          </View>
          <View style={styles.treeContainer}>
            <FlatList
              data={entries}
              keyExtractor={keyExtractor}
              renderItem={renderEntry}
              scrollEnabled={false}
              ListEmptyComponent={
                <View style={styles.emptyState}>
                  <Text style={styles.emptyText}>No files found</Text>
                </View>
              }
            />
          </View>
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
  overviewCard: {
    backgroundColor: colors.bgSecondary,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    padding: 16,
    gap: 10,
  },
  description: {
    fontSize: 14,
    color: colors.text,
    lineHeight: 20,
  },
  metaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  metaItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  langDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.accentPurple,
  },
  metaIcon: {
    fontSize: 12,
    color: colors.textMuted,
  },
  metaText: {
    fontSize: 13,
    color: colors.textMuted,
  },
  branchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    backgroundColor: colors.bg,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
    alignSelf: 'flex-start',
  },
  branchIcon: {
    fontSize: 12,
    color: colors.textMuted,
  },
  branchText: {
    fontSize: 13,
    fontFamily: 'monospace',
    color: colors.text,
  },
  quickNav: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.bgSecondary,
  },
  navButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    gap: 6,
    borderRightWidth: 1,
    borderRightColor: colors.border,
  },
  navIcon: {
    fontSize: 14,
    color: colors.textMuted,
  },
  navLabel: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.text,
  },
  countBadge: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 10,
    backgroundColor: colors.accentYellow,
    minWidth: 18,
    alignItems: 'center',
  },
  countText: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.bg,
  },
  treeSection: {
    marginTop: 8,
  },
  treeSectionHeader: {
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  treeSectionTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  treeContainer: {
    backgroundColor: colors.bgSecondary,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: 10,
  },
  fileIcon: {
    fontSize: 15,
  },
  fileName: {
    flex: 1,
    fontSize: 14,
    color: colors.textLink,
  },
  chevron: {
    fontSize: 18,
    color: colors.textMuted,
  },
  emptyState: {
    padding: 24,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 14,
    color: colors.textMuted,
  },
});
