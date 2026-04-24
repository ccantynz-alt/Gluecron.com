import React, { useCallback } from 'react';
import {
  FlatList,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useGates } from '../hooks/useGates';
import { GateStatusBadge } from '../components/GateStatusBadge';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { ErrorBanner } from '../components/ErrorBanner';
import { colors } from '../theme/colors';
import type { RepoStackParamList } from '../navigation/AppNavigator';
import type { GateRun } from '../api/gates';

type Props = NativeStackScreenProps<RepoStackParamList, 'GateStatus'>;

function formatRelative(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function duration(start: string, end: string | null): string {
  if (!end) return 'running...';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

function GateRunCard({ run }: { run: GateRun }): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false);

  return (
    <View style={styles.runCard}>
      <View style={styles.runHeader}>
        <GateStatusBadge status={run.status} aiRepaired={run.aiRepaired} size="small" />
        <View style={styles.runMeta}>
          <Text style={styles.runBranch}>{run.branch}</Text>
          <Text style={styles.runSha}>{run.commitSha.slice(0, 7)}</Text>
        </View>
        <Text style={styles.runTime}>{formatRelative(run.createdAt)}</Text>
      </View>

      <View style={styles.runDetails}>
        <Text style={styles.runDetailText}>
          Duration: {duration(run.startedAt, run.completedAt)}
        </Text>
        {run.triggeredBy !== null && (
          <Text style={styles.runDetailText}>Triggered by {run.triggeredBy}</Text>
        )}
        {run.aiRepaired && run.repairedCommitSha !== null && (
          <View style={styles.repairedRow}>
            <Text style={styles.sparkle}>✦</Text>
            <Text style={styles.repairedText}>
              AI auto-repaired → {run.repairedCommitSha.slice(0, 7)}
            </Text>
          </View>
        )}
      </View>

      {run.output !== null && run.output.length > 0 && (
        <TouchableOpacity
          style={styles.outputToggle}
          onPress={() => setExpanded((v) => !v)}
          activeOpacity={0.8}
        >
          <Text style={styles.outputToggleText}>
            {expanded ? '▾ Hide output' : '▸ Show output'}
          </Text>
        </TouchableOpacity>
      )}

      {expanded && run.output !== null && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={styles.outputBox}>
            <Text style={styles.outputText} selectable>
              {run.output}
            </Text>
          </View>
        </ScrollView>
      )}
    </View>
  );
}

export function GateStatusScreen({ route }: Props): React.ReactElement {
  const { owner, repo } = route.params;
  const { runs, isLoading, error, isTriggering, triggerRun, loadMore, hasMore, refresh } =
    useGates(owner, repo);

  const renderRun = useCallback(
    ({ item }: { item: GateRun }) => <GateRunCard run={item} />,
    [],
  );

  const keyExtractor = useCallback((item: GateRun) => item.id, []);

  const renderFooter = useCallback(
    () => (hasMore ? <LoadingSpinner size="small" /> : null),
    [hasMore],
  );

  // Summary stats
  const passed = runs.filter((r) => r.status === 'passed').length;
  const failed = runs.filter((r) => r.status === 'failed').length;
  const repaired = runs.filter((r) => r.aiRepaired).length;

  if (isLoading && runs.length === 0) return <LoadingSpinner fullScreen />;

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      {error !== null && <ErrorBanner message={error} onRetry={refresh} />}

      <FlatList
        data={runs}
        keyExtractor={keyExtractor}
        renderItem={renderRun}
        onEndReached={loadMore}
        onEndReachedThreshold={0.3}
        ListFooterComponent={renderFooter}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={
          <View>
            {/* Stats banner */}
            <View style={styles.statsBanner}>
              <View style={styles.statItem}>
                <Text style={[styles.statValue, { color: colors.accent }]}>{passed}</Text>
                <Text style={styles.statLabel}>Passed</Text>
              </View>
              <View style={[styles.statItem, styles.statItemBorder]}>
                <Text style={[styles.statValue, { color: colors.accentRed }]}>{failed}</Text>
                <Text style={styles.statLabel}>Failed</Text>
              </View>
              <View style={styles.statItem}>
                <Text style={[styles.statValue, { color: colors.accentPurple }]}>{repaired}</Text>
                <Text style={styles.statLabel}>AI Repaired</Text>
              </View>
            </View>

            {/* Trigger button */}
            <View style={styles.triggerSection}>
              <TouchableOpacity
                style={[styles.triggerButton, isTriggering && styles.triggerButtonDisabled]}
                onPress={triggerRun}
                disabled={isTriggering}
                activeOpacity={0.8}
              >
                {isTriggering ? (
                  <ActivityIndicator size="small" color={colors.text} />
                ) : (
                  <Text style={styles.triggerText}>⚡ Run Gate Check</Text>
                )}
              </TouchableOpacity>
            </View>

            {runs.length > 0 && (
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>Gate Run History</Text>
              </View>
            )}
          </View>
        }
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>No gate runs yet</Text>
            <Text style={styles.emptySubText}>
              Gate checks run automatically on every push to the default branch.
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
  listContent: {
    paddingBottom: 24,
  },
  statsBanner: {
    flexDirection: 'row',
    backgroundColor: colors.bgSecondary,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  statItem: {
    flex: 1,
    paddingVertical: 16,
    alignItems: 'center',
    gap: 4,
  },
  statItemBorder: {
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: colors.border,
  },
  statValue: {
    fontSize: 24,
    fontWeight: '700',
  },
  statLabel: {
    fontSize: 11,
    color: colors.textMuted,
  },
  triggerSection: {
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  triggerButton: {
    backgroundColor: colors.bgTertiary,
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.accentBlue,
    minHeight: 44,
    justifyContent: 'center',
  },
  triggerButtonDisabled: {
    opacity: 0.5,
  },
  triggerText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.accentBlue,
  },
  sectionHeader: {
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  runCard: {
    backgroundColor: colors.bgSecondary,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    marginHorizontal: 16,
    marginBottom: 10,
    borderRadius: 8,
    borderWidth: 1,
    overflow: 'hidden',
  },
  runHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    gap: 10,
  },
  runMeta: {
    flex: 1,
    gap: 2,
  },
  runBranch: {
    fontSize: 13,
    fontFamily: 'monospace',
    color: colors.text,
  },
  runSha: {
    fontSize: 11,
    fontFamily: 'monospace',
    color: colors.textMuted,
  },
  runTime: {
    fontSize: 12,
    color: colors.textMuted,
  },
  runDetails: {
    paddingHorizontal: 12,
    paddingBottom: 10,
    gap: 3,
  },
  runDetailText: {
    fontSize: 12,
    color: colors.textMuted,
  },
  repairedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 4,
  },
  sparkle: {
    fontSize: 12,
    color: colors.accentPurple,
  },
  repairedText: {
    fontSize: 12,
    color: colors.accentPurple,
    fontFamily: 'monospace',
  },
  outputToggle: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  outputToggleText: {
    fontSize: 12,
    color: colors.textLink,
  },
  outputBox: {
    padding: 12,
    backgroundColor: colors.bg,
  },
  outputText: {
    fontSize: 11,
    fontFamily: 'monospace',
    color: colors.text,
    lineHeight: 16,
  },
  emptyState: {
    padding: 40,
    alignItems: 'center',
    gap: 8,
  },
  emptyText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.textMuted,
  },
  emptySubText: {
    fontSize: 13,
    color: colors.textMuted,
    textAlign: 'center',
    lineHeight: 18,
  },
});
