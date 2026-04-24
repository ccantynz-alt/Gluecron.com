import React, { useCallback, useEffect, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  getPullRequest,
  getPrComments,
  getAiReview,
  createPrComment,
  mergePullRequest,
  closePullRequest,
} from '../api/pulls';
import type { PullRequest, PrComment, AiReviewSummary } from '../api/pulls';
import { AiReviewCard } from '../components/AiReviewCard';
import { GateStatusBadge } from '../components/GateStatusBadge';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { ErrorBanner } from '../components/ErrorBanner';
import { colors } from '../theme/colors';
import type { RepoStackParamList } from '../navigation/AppNavigator';
import { useAuthStore } from '../store/authStore';

type Props = NativeStackScreenProps<RepoStackParamList, 'PullDetail'>;

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

function prStateColor(state: PullRequest['state']): string {
  switch (state) {
    case 'open': return colors.accent;
    case 'merged': return colors.accentPurple;
    case 'closed': return colors.accentRed;
  }
}

function HumanComment({ comment }: { comment: PrComment }): React.ReactElement {
  return (
    <View style={styles.commentCard}>
      <View style={styles.commentHeader}>
        <Text style={styles.commentAuthor}>{comment.authorUsername}</Text>
        {comment.isAiReview && (
          <View style={styles.aiTag}>
            <Text style={styles.aiTagText}>✦ AI</Text>
          </View>
        )}
        <Text style={styles.commentTime}>{formatRelative(comment.createdAt)}</Text>
      </View>
      {comment.filePath !== null && (
        <View style={styles.fileRef}>
          <Text style={styles.fileRefText} numberOfLines={1}>
            {comment.filePath}{comment.lineNumber !== null ? `:${comment.lineNumber}` : ''}
          </Text>
        </View>
      )}
      <Text style={styles.commentBody}>{comment.body}</Text>
    </View>
  );
}

export function PullDetailScreen({ route }: Props): React.ReactElement {
  const { owner, repo, number } = route.params;
  const currentUser = useAuthStore((s) => s.user);

  const [pr, setPr] = useState<PullRequest | null>(null);
  const [comments, setComments] = useState<PrComment[]>([]);
  const [aiReview, setAiReview] = useState<AiReviewSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [commentText, setCommentText] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [mergeSuccess, setMergeSuccess] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    Promise.all([
      getPullRequest(owner, repo, number),
      getPrComments(owner, repo, number),
      getAiReview(owner, repo, number),
    ])
      .then(([prData, commentsData, reviewData]) => {
        if (!cancelled) {
          setPr(prData);
          // Human comments: exclude inline AI comments (those are shown in AiReviewCard)
          setComments(commentsData.filter((c) => !c.isAiReview));
          setAiReview(reviewData);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load pull request');
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [owner, repo, number, tick]);

  const handleMerge = useCallback(async () => {
    if (!pr || isSubmitting) return;
    setIsSubmitting(true);
    setError(null);
    try {
      await mergePullRequest(owner, repo, number);
      setMergeSuccess(true);
      setTick((t) => t + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Merge failed');
    } finally {
      setIsSubmitting(false);
    }
  }, [pr, owner, repo, number, isSubmitting]);

  const handleClose = useCallback(async () => {
    if (!pr || isSubmitting) return;
    setIsSubmitting(true);
    setError(null);
    try {
      const updated = await closePullRequest(owner, repo, number);
      setPr(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to close PR');
    } finally {
      setIsSubmitting(false);
    }
  }, [pr, owner, repo, number, isSubmitting]);

  const handleSubmitComment = useCallback(async () => {
    const body = commentText.trim();
    if (!body || isSubmitting) return;
    setIsSubmitting(true);
    try {
      const newComment = await createPrComment(owner, repo, number, { body });
      setComments((prev) => [...prev, newComment]);
      setCommentText('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to post comment');
    } finally {
      setIsSubmitting(false);
    }
  }, [owner, repo, number, commentText, isSubmitting]);

  const renderComment = useCallback(
    ({ item }: { item: PrComment }) => <HumanComment comment={item} />,
    [],
  );

  const keyExtractor = useCallback((item: PrComment) => String(item.id), []);

  const canMerge =
    pr?.state === 'open' &&
    currentUser !== null &&
    pr.gateStatus !== 'failed' &&
    !mergeSuccess;

  if (isLoading) return <LoadingSpinner fullScreen />;

  if (pr === null) {
    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <ErrorBanner
          message={error ?? 'Pull request not found'}
          onRetry={() => setTick((t) => t + 1)}
        />
      </SafeAreaView>
    );
  }

  const stateColor = prStateColor(pr.state);

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
      >
        <FlatList
          data={comments}
          keyExtractor={keyExtractor}
          renderItem={renderComment}
          style={styles.list}
          contentContainerStyle={styles.listContent}
          ListHeaderComponent={
            <View>
              {error !== null && <ErrorBanner message={error} />}

              {/* PR header */}
              <View style={styles.prHeader}>
                <View style={styles.titleRow}>
                  <View style={[styles.stateBadge, { backgroundColor: stateColor }]}>
                    <Text style={styles.stateText}>{pr.state}</Text>
                  </View>
                  {pr.isDraft && (
                    <View style={styles.draftBadge}>
                      <Text style={styles.draftText}>Draft</Text>
                    </View>
                  )}
                </View>

                <Text style={styles.prTitle}>{pr.title}</Text>

                <Text style={styles.prMeta}>
                  #{pr.number} by {pr.authorUsername} · {formatRelative(pr.createdAt)}
                </Text>

                {/* Branch info */}
                <View style={styles.branchInfo}>
                  <Text style={styles.branchText}>{pr.headBranch}</Text>
                  <Text style={styles.branchArrow}> → </Text>
                  <Text style={styles.branchText}>{pr.baseBranch}</Text>
                </View>

                {/* Gate status */}
                <View style={styles.gateRow}>
                  <Text style={styles.gateLabel}>Gate:</Text>
                  <GateStatusBadge
                    status={pr.gateStatus === 'none' ? 'pending' : pr.gateStatus}
                    size="small"
                  />
                </View>

                {/* Stats */}
                <View style={styles.statsRow}>
                  <Text style={styles.statItem}>
                    <Text style={{ color: colors.accent }}>+{pr.additions}</Text>
                    {' '}
                    <Text style={{ color: colors.accentRed }}>-{pr.deletions}</Text>
                  </Text>
                  <Text style={styles.statDot}>·</Text>
                  <Text style={styles.statItem}>{pr.changedFiles} files</Text>
                  <Text style={styles.statDot}>·</Text>
                  <Text style={styles.statItem}>{pr.commitCount} commits</Text>
                </View>
              </View>

              {/* PR body */}
              {pr.body !== null && pr.body.length > 0 && (
                <View style={styles.prBody}>
                  <Text style={styles.bodyText}>{pr.body}</Text>
                </View>
              )}

              {/* AI Review */}
              {aiReview !== null && (
                <View style={styles.aiSection}>
                  <AiReviewCard review={aiReview} />
                </View>
              )}

              {/* Merge / Close buttons */}
              {pr.state === 'open' && currentUser !== null && (
                <View style={styles.actionsRow}>
                  <TouchableOpacity
                    style={[styles.mergeButton, !canMerge && styles.buttonDisabled]}
                    onPress={handleMerge}
                    disabled={!canMerge || isSubmitting}
                    activeOpacity={0.8}
                  >
                    {isSubmitting ? (
                      <ActivityIndicator size="small" color={colors.text} />
                    ) : (
                      <Text style={styles.mergeText}>
                        {mergeSuccess ? 'Merged!' : 'Merge Pull Request'}
                      </Text>
                    )}
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.closeButton, isSubmitting && styles.buttonDisabled]}
                    onPress={handleClose}
                    disabled={isSubmitting}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.closeText}>Close PR</Text>
                  </TouchableOpacity>
                </View>
              )}

              {pr.state === 'merged' && (
                <View style={styles.mergedBanner}>
                  <Text style={styles.mergedBannerText}>
                    ✓ Merged by {pr.mergedByUsername ?? 'unknown'} · {pr.mergedAt !== null ? formatRelative(pr.mergedAt) : ''}
                  </Text>
                </View>
              )}

              {/* Comments header */}
              {comments.length > 0 && (
                <View style={styles.commentsHeader}>
                  <Text style={styles.commentsHeaderText}>
                    {comments.length} {comments.length === 1 ? 'review comment' : 'review comments'}
                  </Text>
                </View>
              )}
            </View>
          }
          ListEmptyComponent={
            <View style={styles.noComments}>
              <Text style={styles.noCommentsText}>No review comments yet</Text>
            </View>
          }
        />

        {/* Comment input */}
        <View style={styles.inputArea}>
          <View style={styles.inputRow}>
            <TextInput
              style={styles.commentInput}
              value={commentText}
              onChangeText={setCommentText}
              placeholder="Leave a review comment..."
              placeholderTextColor={colors.textMuted}
              multiline
              maxLength={65536}
            />
            <TouchableOpacity
              style={[styles.sendButton, (!commentText.trim() || isSubmitting) && styles.sendButtonDisabled]}
              onPress={handleSubmitComment}
              disabled={!commentText.trim() || isSubmitting}
              activeOpacity={0.8}
            >
              <Text style={styles.sendIcon}>↑</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  flex: {
    flex: 1,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingBottom: 8,
  },
  prHeader: {
    padding: 16,
    backgroundColor: colors.bgSecondary,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: 10,
  },
  titleRow: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
  },
  stateBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
  },
  stateText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.text,
    textTransform: 'capitalize',
  },
  draftBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 20,
    backgroundColor: colors.bgTertiary,
    borderWidth: 1,
    borderColor: colors.border,
  },
  draftText: {
    fontSize: 12,
    color: colors.textMuted,
  },
  prTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.text,
    lineHeight: 26,
  },
  prMeta: {
    fontSize: 13,
    color: colors.textMuted,
  },
  branchInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bg,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: colors.border,
    alignSelf: 'flex-start',
  },
  branchText: {
    fontSize: 12,
    fontFamily: 'monospace',
    color: colors.textLink,
  },
  branchArrow: {
    fontSize: 12,
    color: colors.textMuted,
  },
  gateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  gateLabel: {
    fontSize: 13,
    color: colors.textMuted,
  },
  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  statItem: {
    fontSize: 13,
    color: colors.textMuted,
  },
  statDot: {
    fontSize: 13,
    color: colors.textMuted,
  },
  prBody: {
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  bodyText: {
    fontSize: 14,
    color: colors.text,
    lineHeight: 22,
  },
  aiSection: {
    paddingTop: 16,
  },
  actionsRow: {
    flexDirection: 'row',
    padding: 16,
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  mergeButton: {
    flex: 2,
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  mergeText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
  },
  closeButton: {
    flex: 1,
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.accentRed,
    minHeight: 44,
  },
  closeText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.accentRed,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  mergedBanner: {
    margin: 16,
    padding: 12,
    borderRadius: 8,
    backgroundColor: colors.bgSecondary,
    borderWidth: 1,
    borderColor: colors.accentPurple,
  },
  mergedBannerText: {
    fontSize: 13,
    color: colors.accentPurple,
    textAlign: 'center',
  },
  commentsHeader: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.bgTertiary,
  },
  commentsHeaderText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  commentCard: {
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.bgSecondary,
    gap: 8,
  },
  commentHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  commentAuthor: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text,
  },
  aiTag: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 10,
    backgroundColor: colors.bgTertiary,
    borderWidth: 1,
    borderColor: colors.accentPurple,
  },
  aiTagText: {
    fontSize: 10,
    color: colors.accentPurple,
    fontWeight: '600',
  },
  commentTime: {
    fontSize: 12,
    color: colors.textMuted,
    marginLeft: 'auto',
  },
  fileRef: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    backgroundColor: colors.bgTertiary,
    borderWidth: 1,
    borderColor: colors.border,
    alignSelf: 'flex-start',
  },
  fileRefText: {
    fontSize: 11,
    fontFamily: 'monospace',
    color: colors.textMuted,
  },
  commentBody: {
    fontSize: 14,
    color: colors.text,
    lineHeight: 20,
  },
  noComments: {
    padding: 32,
    alignItems: 'center',
  },
  noCommentsText: {
    fontSize: 14,
    color: colors.textMuted,
  },
  inputArea: {
    padding: 12,
    backgroundColor: colors.bgSecondary,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 10,
  },
  commentInput: {
    flex: 1,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    padding: 10,
    fontSize: 14,
    color: colors.text,
    maxHeight: 100,
    minHeight: 44,
  },
  sendButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.accentBlue,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButtonDisabled: {
    opacity: 0.4,
  },
  sendIcon: {
    fontSize: 18,
    color: colors.bg,
    fontWeight: '700',
  },
});
