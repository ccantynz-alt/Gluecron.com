import React from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { type RouteProp } from '@react-navigation/native';
import { colors } from '../theme/colors';
import { fontSizes, fontWeights, fonts } from '../theme/typography';
import { usePull } from '../hooks/usePulls';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { ErrorState } from '../components/ErrorState';
import { type MainStackParamList } from '../navigation/types';

type Props = {
  route: RouteProp<MainStackParamList, 'PullDetail'>;
};

function stateColor(state: string): string {
  switch (state) {
    case 'open': return colors.green;
    case 'merged': return colors.accent;
    case 'closed': return colors.red;
    default: return colors.textMuted;
  }
}

function stateLabel(state: string): string {
  switch (state) {
    case 'open': return 'Open';
    case 'merged': return 'Merged';
    case 'closed': return 'Closed';
    default: return state;
  }
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function renderBody(text: string | null) {
  if (!text) return null;
  return text.split('\n').map((line, i) => {
    if (!line.trim()) return <Text key={i} style={{ height: 8 }} />;
    return <Text key={i} style={styles.bodyLine}>{line}</Text>;
  });
}

export function PullDetailScreen({ route }: Props) {
  const { owner, repo, number } = route.params;
  const { pull, comments, loading, error, refresh } = usePull(owner, repo, number);

  if (loading) return <LoadingSpinner fullScreen />;
  if (error || !pull) return <ErrorState message={error || 'PR not found'} onRetry={refresh} />;

  const sc = stateColor(pull.state);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        {/* Header */}
        <View style={styles.prHeader}>
          <View style={[styles.stateBadge, { backgroundColor: sc + '22', borderColor: sc }]}>
            <Text style={[styles.stateText, { color: sc }]}>{stateLabel(pull.state)}</Text>
          </View>
          <Text style={styles.prNum}>#{pull.number}</Text>
        </View>

        <Text style={styles.title}>{pull.title}</Text>

        <View style={styles.branchRow}>
          <Text style={styles.branch}>{pull.headBranch}</Text>
          <Text style={styles.branchArrow}> → </Text>
          <Text style={styles.branch}>{pull.baseBranch}</Text>
        </View>

        <Text style={styles.meta}>
          opened {timeAgo(pull.createdAt)}
          {pull.mergedAt ? ` · merged ${timeAgo(pull.mergedAt)}` : ''}
          {pull.closedAt && !pull.mergedAt ? ` · closed ${timeAgo(pull.closedAt)}` : ''}
        </Text>

        {/* Description */}
        {pull.body ? (
          <View style={styles.bodyWrap}>
            {renderBody(pull.body)}
          </View>
        ) : (
          <Text style={styles.noBody}>No description provided.</Text>
        )}

        {/* Comments */}
        {comments.length > 0 && (
          <View style={styles.commentsSection}>
            <Text style={styles.commentsTitle}>
              {comments.length} comment{comments.length !== 1 ? 's' : ''}
            </Text>
            {comments.map((c) => (
              <View key={c.id} style={[styles.commentCard, c.isAiReview && styles.aiCommentCard]}>
                <View style={styles.commentHeader}>
                  <Text style={styles.commentAuthor}>
                    {c.isAiReview ? '⬡ AI Review' : (c.author?.username ?? 'Unknown')}
                  </Text>
                  <Text style={styles.commentTime}>{timeAgo(c.createdAt)}</Text>
                </View>
                {c.filePath && (
                  <Text style={styles.filePath}>
                    {c.filePath}{c.line != null ? `:${c.line}` : ''}
                  </Text>
                )}
                <Text style={styles.commentBody}>{c.body}</Text>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  scroll: { flex: 1 },
  content: { padding: 16, paddingBottom: 32 },
  prHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 10,
  },
  stateBadge: {
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderWidth: 1,
  },
  stateText: { fontSize: fontSizes.sm, fontWeight: fontWeights.medium },
  prNum: { color: colors.textMuted, fontSize: fontSizes.sm },
  title: {
    fontSize: fontSizes.xl,
    fontWeight: fontWeights.bold,
    color: colors.text,
    lineHeight: 28,
    marginBottom: 8,
  },
  branchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
    flexWrap: 'wrap',
  },
  branch: {
    color: colors.accent,
    fontSize: fontSizes.sm,
    fontFamily: fonts.mono,
    backgroundColor: colors.accentDim,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  branchArrow: { color: colors.textMuted, fontSize: fontSizes.sm, marginHorizontal: 4 },
  meta: { color: colors.textMuted, fontSize: fontSizes.sm, marginBottom: 16 },
  bodyWrap: {
    backgroundColor: colors.bgSurface,
    borderRadius: 8,
    padding: 14,
    marginBottom: 24,
    borderWidth: 1,
    borderColor: colors.border,
  },
  bodyLine: { color: colors.text, fontSize: fontSizes.sm, lineHeight: 20 },
  noBody: { color: colors.textMuted, fontSize: fontSizes.sm, fontStyle: 'italic', marginBottom: 24 },
  commentsSection: { borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 20 },
  commentsTitle: { color: colors.textMuted, fontSize: fontSizes.sm, fontWeight: fontWeights.medium, marginBottom: 14 },
  commentCard: {
    backgroundColor: colors.bgSurface,
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },
  aiCommentCard: {
    borderColor: colors.accent + '55',
    backgroundColor: colors.accentDim,
  },
  commentHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  commentAuthor: { color: colors.accent, fontSize: fontSizes.sm, fontWeight: fontWeights.medium },
  commentTime: { color: colors.textMuted, fontSize: fontSizes.xs },
  filePath: {
    color: colors.textMuted,
    fontSize: fontSizes.xs,
    fontFamily: fonts.mono,
    marginBottom: 6,
    backgroundColor: colors.bgSecondary,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    alignSelf: 'flex-start',
  },
  commentBody: { color: colors.text, fontSize: fontSizes.sm, lineHeight: 20 },
});
