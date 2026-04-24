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
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { getIssue, getIssueComments, createIssueComment, closeIssue, reopenIssue } from '../api/issues';
import type { Issue, IssueComment } from '../api/issues';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { ErrorBanner } from '../components/ErrorBanner';
import { colors } from '../theme/colors';
import type { RepoStackParamList } from '../navigation/AppNavigator';
import { useAuthStore } from '../store/authStore';

type Props = NativeStackScreenProps<RepoStackParamList, 'IssueDetail'>;

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

function CommentCard({ comment }: { comment: IssueComment }): React.ReactElement {
  return (
    <View style={styles.commentCard}>
      <View style={styles.commentHeader}>
        <Text style={styles.commentAuthor}>{comment.authorUsername}</Text>
        <Text style={styles.commentTime}>{formatRelative(comment.createdAt)}</Text>
      </View>
      <Text style={styles.commentBody}>{comment.body}</Text>
    </View>
  );
}

export function IssueDetailScreen({ route }: Props): React.ReactElement {
  const { owner, repo, number } = route.params;
  const currentUser = useAuthStore((s) => s.user);

  const [issue, setIssue] = useState<Issue | null>(null);
  const [comments, setComments] = useState<IssueComment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [commentText, setCommentText] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    Promise.all([
      getIssue(owner, repo, number),
      getIssueComments(owner, repo, number),
    ])
      .then(([issueData, commentData]) => {
        if (!cancelled) {
          setIssue(issueData);
          setComments(commentData);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load issue');
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [owner, repo, number, tick]);

  const handleSubmitComment = useCallback(async () => {
    const body = commentText.trim();
    if (!body || isSubmitting) return;
    setIsSubmitting(true);
    try {
      const newComment = await createIssueComment(owner, repo, number, { body });
      setComments((prev) => [...prev, newComment]);
      setCommentText('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to post comment');
    } finally {
      setIsSubmitting(false);
    }
  }, [owner, repo, number, commentText, isSubmitting]);

  const handleToggleState = useCallback(async () => {
    if (!issue || isSubmitting) return;
    setIsSubmitting(true);
    try {
      const updated = issue.state === 'open'
        ? await closeIssue(owner, repo, number)
        : await reopenIssue(owner, repo, number);
      setIssue(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update issue');
    } finally {
      setIsSubmitting(false);
    }
  }, [issue, owner, repo, number, isSubmitting]);

  const renderComment = useCallback(
    ({ item }: { item: IssueComment }) => <CommentCard comment={item} />,
    [],
  );

  const keyExtractor = useCallback((item: IssueComment) => String(item.id), []);

  if (isLoading) return <LoadingSpinner fullScreen />;

  if (issue === null) {
    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <ErrorBanner message={error ?? 'Issue not found'} onRetry={() => setTick((t) => t + 1)} />
      </SafeAreaView>
    );
  }

  const stateColor = issue.state === 'open' ? colors.accent : colors.accentRed;

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

              {/* Issue header */}
              <View style={styles.issueHeader}>
                <View style={[styles.stateBadge, { backgroundColor: stateColor }]}>
                  <Text style={styles.stateText}>{issue.state}</Text>
                </View>
                <Text style={styles.issueTitle}>{issue.title}</Text>
                <Text style={styles.issueMeta}>
                  #{issue.number} opened {formatRelative(issue.createdAt)} by {issue.authorUsername}
                </Text>

                {/* Labels */}
                {issue.labels.length > 0 && (
                  <View style={styles.labelsRow}>
                    {issue.labels.map((label) => (
                      <View
                        key={label.id}
                        style={[styles.label, { borderColor: `#${label.color}` }]}
                      >
                        <Text style={[styles.labelText, { color: `#${label.color}` }]}>
                          {label.name}
                        </Text>
                      </View>
                    ))}
                  </View>
                )}
              </View>

              {/* Issue body */}
              {issue.body !== null && issue.body.length > 0 && (
                <View style={styles.issueBody}>
                  <Text style={styles.bodyText}>{issue.body}</Text>
                </View>
              )}

              {/* Comments section header */}
              {comments.length > 0 && (
                <View style={styles.commentsHeader}>
                  <Text style={styles.commentsHeaderText}>
                    {comments.length} {comments.length === 1 ? 'comment' : 'comments'}
                  </Text>
                </View>
              )}
            </View>
          }
          ListEmptyComponent={
            <View style={styles.noComments}>
              <Text style={styles.noCommentsText}>No comments yet</Text>
            </View>
          }
        />

        {/* Comment input + actions */}
        <View style={styles.inputArea}>
          <View style={styles.inputRow}>
            <TextInput
              style={styles.commentInput}
              value={commentText}
              onChangeText={setCommentText}
              placeholder="Leave a comment..."
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

          {currentUser !== null && (
            <TouchableOpacity
              style={[styles.stateToggle, { borderColor: stateColor }, isSubmitting && styles.disabled]}
              onPress={handleToggleState}
              disabled={isSubmitting}
              activeOpacity={0.8}
            >
              <Text style={[styles.stateToggleText, { color: stateColor }]}>
                {issue.state === 'open' ? 'Close Issue' : 'Reopen Issue'}
              </Text>
            </TouchableOpacity>
          )}
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
  issueHeader: {
    padding: 16,
    backgroundColor: colors.bgSecondary,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: 8,
  },
  stateBadge: {
    alignSelf: 'flex-start',
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
  issueTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.text,
    lineHeight: 26,
  },
  issueMeta: {
    fontSize: 13,
    color: colors.textMuted,
  },
  labelsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 4,
  },
  label: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 20,
    borderWidth: 1,
  },
  labelText: {
    fontSize: 11,
    fontWeight: '500',
  },
  issueBody: {
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  bodyText: {
    fontSize: 14,
    color: colors.text,
    lineHeight: 22,
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
    justifyContent: 'space-between',
  },
  commentAuthor: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text,
  },
  commentTime: {
    fontSize: 12,
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
    gap: 8,
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
  stateToggle: {
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
  },
  stateToggleText: {
    fontSize: 14,
    fontWeight: '600',
  },
  disabled: {
    opacity: 0.5,
  },
});
