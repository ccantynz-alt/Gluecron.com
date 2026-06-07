import React, { useState, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { type RouteProp } from '@react-navigation/native';
import { colors } from '../theme/colors';
import { fontSizes, fontWeights } from '../theme/typography';
import { useIssue } from '../hooks/useIssues';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { ErrorState } from '../components/ErrorState';
import { type MainStackParamList } from '../navigation/MainTabNavigator';

type Props = {
  route: RouteProp<MainStackParamList, 'IssueDetail'>;
};

function renderBody(text: string | null) {
  if (!text) return null;
  // Simple markdown-ish rendering: bold, italic, code spans
  const lines = text.split('\n');
  return lines.map((line, i) => {
    // Headings
    if (line.startsWith('### ')) {
      return <Text key={i} style={styles.h3}>{line.slice(4)}</Text>;
    }
    if (line.startsWith('## ')) {
      return <Text key={i} style={styles.h2}>{line.slice(3)}</Text>;
    }
    if (line.startsWith('# ')) {
      return <Text key={i} style={styles.h1}>{line.slice(2)}</Text>;
    }
    // Code block lines
    if (line.startsWith('```') || line.startsWith('    ')) {
      return <Text key={i} style={styles.codeLine}>{line}</Text>;
    }
    if (!line.trim()) {
      return <Text key={i} style={styles.emptyLine}>{'\n'}</Text>;
    }
    return <Text key={i} style={styles.bodyLine}>{line}</Text>;
  });
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

export function IssueDetailScreen({ route }: Props) {
  const { owner, repo, number } = route.params;
  const { issue, comments, loading, error, submitting, refresh, addComment } = useIssue(owner, repo, number);
  const [commentText, setCommentText] = useState('');
  const scrollRef = useRef<ScrollView>(null);

  async function handleSubmit() {
    const trimmed = commentText.trim();
    if (!trimmed) return;
    try {
      await addComment(trimmed);
      setCommentText('');
      scrollRef.current?.scrollToEnd({ animated: true });
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Failed to post comment');
    }
  }

  if (loading) return <LoadingSpinner fullScreen />;
  if (error || !issue) return <ErrorState message={error || 'Issue not found'} onRetry={refresh} />;

  const isOpen = issue.state === 'open';

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.kav}>
        <ScrollView ref={scrollRef} style={styles.scroll} contentContainerStyle={styles.content}>
          {/* Issue header */}
          <View style={styles.issueHeader}>
            <View style={[styles.stateBadge, { backgroundColor: isOpen ? colors.green + '22' : colors.textMuted + '22' }]}>
              <View style={[styles.stateDot, { backgroundColor: isOpen ? colors.green : colors.textMuted }]} />
              <Text style={[styles.stateText, { color: isOpen ? colors.green : colors.textMuted }]}>
                {isOpen ? 'Open' : 'Closed'}
              </Text>
            </View>
            <Text style={styles.number}>#{issue.number}</Text>
          </View>

          <Text style={styles.title}>{issue.title}</Text>

          <Text style={styles.meta}>
            opened {timeAgo(issue.createdAt)}
          </Text>

          {/* Body */}
          {issue.body ? (
            <View style={styles.bodyWrap}>
              {renderBody(issue.body)}
            </View>
          ) : (
            <Text style={styles.noBody}>No description provided.</Text>
          )}

          {/* Comments */}
          {comments.length > 0 && (
            <View style={styles.commentsSection}>
              <Text style={styles.commentsTitle}>{comments.length} comment{comments.length !== 1 ? 's' : ''}</Text>
              {comments.map((comment) => (
                <View key={comment.id} style={styles.commentCard}>
                  <View style={styles.commentHeader}>
                    <Text style={styles.commentAuthor}>
                      {comment.author?.username ?? 'Unknown'}
                    </Text>
                    <Text style={styles.commentTime}>{timeAgo(comment.createdAt)}</Text>
                  </View>
                  <View style={styles.commentBody}>
                    {renderBody(comment.body)}
                  </View>
                </View>
              ))}
            </View>
          )}
        </ScrollView>

        {/* Comment composer */}
        <View style={styles.composer}>
          <TextInput
            style={styles.composerInput}
            value={commentText}
            onChangeText={setCommentText}
            placeholder="Leave a comment..."
            placeholderTextColor={colors.textMuted}
            multiline
            maxLength={65536}
          />
          <TouchableOpacity
            style={[styles.sendBtn, (!commentText.trim() || submitting) && styles.sendBtnDisabled]}
            onPress={handleSubmit}
            disabled={!commentText.trim() || submitting}
            activeOpacity={0.8}
          >
            {submitting ? (
              <ActivityIndicator color={colors.white} size="small" />
            ) : (
              <Text style={styles.sendBtnText}>Comment</Text>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  kav: { flex: 1 },
  scroll: { flex: 1 },
  content: { padding: 16, paddingBottom: 8 },
  issueHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 10,
  },
  stateBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  stateDot: { width: 8, height: 8, borderRadius: 4 },
  stateText: { fontSize: fontSizes.sm, fontWeight: fontWeights.medium },
  number: { color: colors.textMuted, fontSize: fontSizes.sm },
  title: {
    fontSize: fontSizes.xl,
    fontWeight: fontWeights.bold,
    color: colors.text,
    lineHeight: 28,
    marginBottom: 6,
  },
  meta: { color: colors.textMuted, fontSize: fontSizes.sm, marginBottom: 16 },
  bodyWrap: {
    backgroundColor: colors.bgSurface,
    borderRadius: 8,
    padding: 14,
    marginBottom: 24,
    borderWidth: 1,
    borderColor: colors.border,
  },
  noBody: { color: colors.textMuted, fontSize: fontSizes.sm, fontStyle: 'italic', marginBottom: 24 },
  h1: { color: colors.text, fontSize: fontSizes.xl, fontWeight: fontWeights.bold, marginBottom: 6 },
  h2: { color: colors.text, fontSize: fontSizes.lg, fontWeight: fontWeights.bold, marginBottom: 4 },
  h3: { color: colors.text, fontSize: fontSizes.md, fontWeight: fontWeights.semibold, marginBottom: 3 },
  bodyLine: { color: colors.text, fontSize: fontSizes.sm, lineHeight: 20 },
  codeLine: { color: colors.green, fontSize: fontSizes.xs, fontFamily: 'monospace', backgroundColor: colors.bgSecondary, paddingHorizontal: 4 },
  emptyLine: { height: 8 },
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
  commentHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  commentAuthor: { color: colors.accent, fontSize: fontSizes.sm, fontWeight: fontWeights.medium },
  commentTime: { color: colors.textMuted, fontSize: fontSizes.xs },
  commentBody: {},
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: 10,
    backgroundColor: colors.bgSecondary,
  },
  composerInput: {
    flex: 1,
    backgroundColor: colors.bgSurface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    fontSize: fontSizes.sm,
    maxHeight: 120,
    minHeight: 40,
  },
  sendBtn: {
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    minHeight: 40,
    justifyContent: 'center',
  },
  sendBtnDisabled: { opacity: 0.5 },
  sendBtnText: { color: colors.white, fontSize: fontSizes.sm, fontWeight: fontWeights.semibold },
});
