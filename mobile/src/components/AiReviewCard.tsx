import React, { useState, useCallback } from 'react';
import {
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { colors } from '../theme/colors';
import type { AiReviewSummary, PrComment } from '../api/pulls';

interface AiReviewCardProps {
  review: AiReviewSummary;
}

function severityColor(severity: AiReviewSummary['severity']): string {
  switch (severity) {
    case 'error': return colors.accentRed;
    case 'warning': return colors.accentYellow;
    case 'info': return colors.accentBlue;
  }
}

function severityLabel(severity: AiReviewSummary['severity']): string {
  switch (severity) {
    case 'error': return 'Needs Changes';
    case 'warning': return 'Suggestions';
    case 'info': return 'Looks Good';
  }
}

interface InlineCommentProps {
  comment: PrComment;
}

function InlineComment({ comment }: InlineCommentProps): React.ReactElement {
  return (
    <View style={styles.inlineComment}>
      {comment.filePath !== null && (
        <View style={styles.fileHeader}>
          <Text style={styles.filePath} numberOfLines={1}>
            {comment.filePath}
            {comment.lineNumber !== null ? `:${comment.lineNumber}` : ''}
          </Text>
        </View>
      )}
      {comment.diffHunk !== null && (
        <View style={styles.diffHunk}>
          <Text style={styles.diffHunkText} numberOfLines={4}>
            {comment.diffHunk}
          </Text>
        </View>
      )}
      <Text style={styles.commentBody}>{comment.body}</Text>
    </View>
  );
}

export function AiReviewCard({ review }: AiReviewCardProps): React.ReactElement {
  const [expanded, setExpanded] = useState(true);
  const toggle = useCallback(() => setExpanded((v) => !v), []);
  const borderColor = severityColor(review.severity);
  const inlineComments = review.comments.filter((c) => c.filePath !== null);

  const renderComment = useCallback(
    ({ item }: { item: PrComment }) => <InlineComment comment={item} />,
    [],
  );

  const keyExtractor = useCallback((item: PrComment) => String(item.id), []);

  return (
    <View style={[styles.card, { borderColor }]}>
      <TouchableOpacity style={styles.header} onPress={toggle} activeOpacity={0.8}>
        <View style={styles.headerLeft}>
          <Text style={styles.sparkle}>✦</Text>
          <Text style={styles.headerTitle}>AI Review</Text>
          <View style={[styles.severityBadge, { borderColor }]}>
            <Text style={[styles.severityText, { color: borderColor }]}>
              {severityLabel(review.severity)}
            </Text>
          </View>
          {inlineComments.length > 0 && (
            <View style={styles.countBadge}>
              <Text style={styles.countText}>{inlineComments.length} comments</Text>
            </View>
          )}
        </View>
        <Text style={styles.chevron}>{expanded ? '▾' : '▸'}</Text>
      </TouchableOpacity>

      {expanded && (
        <View style={styles.body}>
          <Text style={styles.summary}>{review.summary}</Text>

          {inlineComments.length > 0 && (
            <View style={styles.inlineSection}>
              <Text style={styles.inlineSectionTitle}>Inline Comments</Text>
              <FlatList
                data={inlineComments}
                keyExtractor={keyExtractor}
                renderItem={renderComment}
                scrollEnabled={false}
                ItemSeparatorComponent={() => <View style={styles.separator} />}
              />
            </View>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bgSecondary,
    borderRadius: 8,
    borderWidth: 1,
    marginHorizontal: 16,
    marginBottom: 16,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 14,
    backgroundColor: colors.bgTertiary,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
  },
  sparkle: {
    fontSize: 15,
    color: colors.accentPurple,
  },
  headerTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.accentPurple,
  },
  severityBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 20,
    borderWidth: 1,
  },
  severityText: {
    fontSize: 11,
    fontWeight: '600',
  },
  countBadge: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 20,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  countText: {
    fontSize: 11,
    color: colors.textMuted,
  },
  chevron: {
    fontSize: 14,
    color: colors.textMuted,
    marginLeft: 8,
  },
  body: {
    padding: 14,
    gap: 14,
  },
  summary: {
    fontSize: 14,
    color: colors.text,
    lineHeight: 22,
  },
  inlineSection: {
    gap: 8,
  },
  inlineSectionTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  inlineComment: {
    backgroundColor: colors.bg,
    borderRadius: 6,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
  },
  fileHeader: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: colors.bgTertiary,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  filePath: {
    fontSize: 12,
    fontFamily: 'monospace',
    color: colors.textLink,
  },
  diffHunk: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: colors.bg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  diffHunkText: {
    fontSize: 11,
    fontFamily: 'monospace',
    color: colors.textMuted,
    lineHeight: 16,
  },
  commentBody: {
    padding: 10,
    fontSize: 13,
    color: colors.text,
    lineHeight: 20,
  },
  separator: {
    height: 8,
  },
});
