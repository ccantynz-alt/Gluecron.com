import React, { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  FlatList,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { type NativeStackNavigationProp } from '@react-navigation/native-stack';
import { type RouteProp } from '@react-navigation/native';
import { colors } from '../theme/colors';
import { fontSizes, fontWeights, fonts } from '../theme/typography';
import { useRepo, useFileTree, useCommits } from '../hooks/useRepo';
import { useIssues } from '../hooks/useIssues';
import { usePulls } from '../hooks/usePulls';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { ErrorState } from '../components/ErrorState';
import { CommitRow } from '../components/CommitRow';
import { IssueRow } from '../components/IssueRow';
import { PullRow } from '../components/PullRow';
import { type MainStackParamList } from '../navigation/types';

type Props = {
  navigation: NativeStackNavigationProp<MainStackParamList, 'RepoDetail'>;
  route: RouteProp<MainStackParamList, 'RepoDetail'>;
};

type Tab = 'Code' | 'Issues' | 'PRs' | 'Commits';

const TABS: Tab[] = ['Code', 'Issues', 'PRs', 'Commits'];

export function RepoDetailScreen({ navigation, route }: Props) {
  const { owner, repo: repoName } = route.params;
  const [activeTab, setActiveTab] = useState<Tab>('Code');

  const { repo, loading: repoLoading, error: repoError } = useRepo(owner, repoName);
  const { tree, loading: treeLoading } = useFileTree(owner, repoName, repo?.defaultBranch || 'HEAD');
  const { commits, loading: commitsLoading } = useCommits(owner, repoName);
  const { issues, loading: issuesLoading } = useIssues(owner, repoName, 'open');
  const { pulls, loading: pullsLoading } = usePulls(owner, repoName, 'open');

  if (repoLoading) return <LoadingSpinner fullScreen />;
  if (repoError || !repo) return <ErrorState message={repoError || 'Repo not found'} />;

  const sorted = [...tree].sort((a, b) => {
    if (a.type === 'tree' && b.type !== 'tree') return -1;
    if (a.type !== 'tree' && b.type === 'tree') return 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView stickyHeaderIndices={[1]}>
        {/* Repo header */}
        <View style={styles.header}>
          <Text style={styles.repoName}>
            <Text style={styles.owner}>{owner}/</Text>
            {repo.name}
          </Text>
          {repo.description ? (
            <Text style={styles.desc}>{repo.description}</Text>
          ) : null}

          <View style={styles.statsRow}>
            <View style={styles.stat}>
              <Text style={styles.statIcon}>★</Text>
              <Text style={styles.statVal}>{repo.starCount}</Text>
            </View>
            <View style={styles.stat}>
              <Text style={styles.statIcon}>⑂</Text>
              <Text style={styles.statVal}>{repo.forkCount}</Text>
            </View>
            <View style={styles.stat}>
              <Text style={styles.statIcon}>◉</Text>
              <Text style={styles.statVal}>{repo.issueCount} issues</Text>
            </View>
            <View style={styles.branchBadge}>
              <Text style={styles.branchText}>{repo.defaultBranch}</Text>
            </View>
          </View>
        </View>

        {/* Tab bar — sticky */}
        <View style={styles.tabBar}>
          {TABS.map((tab) => (
            <TouchableOpacity
              key={tab}
              style={[styles.tab, activeTab === tab && styles.tabActive]}
              onPress={() => setActiveTab(tab)}
              activeOpacity={0.75}
            >
              <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>
                {tab}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Code tab */}
        {activeTab === 'Code' && (
          <View style={styles.fileList}>
            {treeLoading ? (
              <LoadingSpinner size="small" />
            ) : sorted.length === 0 ? (
              <Text style={styles.emptyText}>Empty repository</Text>
            ) : (
              sorted.map((entry) => (
                <TouchableOpacity
                  key={entry.path}
                  style={styles.fileRow}
                  activeOpacity={0.75}
                  onPress={() => {
                    if (entry.type === 'blob') {
                      navigation.navigate('FileViewer', {
                        owner,
                        repo: repoName,
                        path: entry.path,
                        ref: repo.defaultBranch,
                      });
                    }
                  }}
                >
                  <Text style={styles.fileIcon}>{entry.type === 'tree' ? '📁' : '📄'}</Text>
                  <Text style={styles.fileName}>{entry.name}</Text>
                  {entry.size !== undefined && entry.type === 'blob' && (
                    <Text style={styles.fileSize}>{formatSize(entry.size)}</Text>
                  )}
                </TouchableOpacity>
              ))
            )}
          </View>
        )}

        {/* Issues tab */}
        {activeTab === 'Issues' && (
          <View>
            {issuesLoading ? (
              <LoadingSpinner size="small" />
            ) : issues.length === 0 ? (
              <Text style={styles.emptyText}>No open issues</Text>
            ) : (
              issues.map((issue) => (
                <IssueRow
                  key={issue.id}
                  issue={issue}
                  onPress={() =>
                    navigation.navigate('IssueDetail', {
                      owner,
                      repo: repoName,
                      number: issue.number,
                    })
                  }
                />
              ))
            )}
          </View>
        )}

        {/* PRs tab */}
        {activeTab === 'PRs' && (
          <View>
            {pullsLoading ? (
              <LoadingSpinner size="small" />
            ) : pulls.length === 0 ? (
              <Text style={styles.emptyText}>No open pull requests</Text>
            ) : (
              pulls.map((pull) => (
                <PullRow
                  key={pull.id}
                  pull={pull}
                  onPress={() =>
                    navigation.navigate('PullDetail', {
                      owner,
                      repo: repoName,
                      number: pull.number,
                    })
                  }
                />
              ))
            )}
          </View>
        )}

        {/* Commits tab */}
        {activeTab === 'Commits' && (
          <View>
            {commitsLoading ? (
              <LoadingSpinner size="small" />
            ) : commits.length === 0 ? (
              <Text style={styles.emptyText}>No commits yet</Text>
            ) : (
              commits.map((commit) => <CommitRow key={commit.sha} commit={commit} />)
            )}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  repoName: {
    fontSize: fontSizes.xl,
    fontWeight: fontWeights.bold,
    color: colors.text,
    marginBottom: 6,
  },
  owner: {
    color: colors.textMuted,
    fontWeight: fontWeights.regular,
  },
  desc: {
    color: colors.textMuted,
    fontSize: fontSizes.sm,
    lineHeight: 18,
    marginBottom: 12,
  },
  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flexWrap: 'wrap',
  },
  stat: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  statIcon: {
    color: colors.textMuted,
    fontSize: fontSizes.sm,
  },
  statVal: {
    color: colors.textMuted,
    fontSize: fontSizes.sm,
  },
  branchBadge: {
    backgroundColor: colors.bgSecondary,
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderWidth: 1,
    borderColor: colors.border,
  },
  branchText: {
    color: colors.textMuted,
    fontSize: fontSizes.xs,
    fontFamily: fonts.mono,
  },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: colors.bg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  tab: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
  },
  tabActive: {
    borderBottomWidth: 2,
    borderBottomColor: colors.accent,
  },
  tabText: {
    color: colors.textMuted,
    fontSize: fontSizes.sm,
    fontWeight: fontWeights.medium,
  },
  tabTextActive: {
    color: colors.accent,
  },
  fileList: {
    padding: 4,
  },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: 10,
  },
  fileIcon: {
    fontSize: 16,
    width: 20,
    textAlign: 'center',
  },
  fileName: {
    flex: 1,
    color: colors.text,
    fontSize: fontSizes.sm,
    fontFamily: fonts.mono,
  },
  fileSize: {
    color: colors.textMuted,
    fontSize: fontSizes.xs,
  },
  emptyText: {
    color: colors.textMuted,
    fontSize: fontSizes.sm,
    textAlign: 'center',
    padding: 32,
  },
});
