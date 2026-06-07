import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { colors } from '../theme/colors';
import { fontSizes, fontWeights } from '../theme/typography';
import { type Issue } from '../api/client';

interface Props {
  issue: Issue;
  onPress: () => void;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export function IssueRow({ issue, onPress }: Props) {
  const isOpen = issue.state === 'open';

  return (
    <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.75}>
      <View style={[styles.dot, { backgroundColor: isOpen ? colors.green : colors.textMuted }]} />

      <View style={styles.content}>
        <Text style={styles.title} numberOfLines={2}>
          {issue.title}
        </Text>

        <View style={styles.meta}>
          <Text style={styles.number}>#{issue.number}</Text>
          <Text style={styles.time}>opened {timeAgo(issue.createdAt)}</Text>
          {typeof issue.commentCount === 'number' && issue.commentCount > 0 && (
            <View style={styles.commentBadge}>
              <Text style={styles.commentText}>◯ {issue.commentCount}</Text>
            </View>
          )}
        </View>

        {issue.labels && issue.labels.length > 0 && (
          <View style={styles.labels}>
            {issue.labels.slice(0, 3).map((label) => (
              <View
                key={label.id}
                style={[styles.label, { backgroundColor: `#${label.color}22`, borderColor: `#${label.color}` }]}
              >
                <Text style={[styles.labelText, { color: `#${label.color}` }]}>{label.name}</Text>
              </View>
            ))}
          </View>
        )}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: 12,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginTop: 5,
    flexShrink: 0,
  },
  content: {
    flex: 1,
    gap: 4,
  },
  title: {
    color: colors.text,
    fontSize: fontSizes.base,
    fontWeight: fontWeights.medium,
    lineHeight: 20,
  },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  number: {
    color: colors.textMuted,
    fontSize: fontSizes.xs,
  },
  time: {
    color: colors.textMuted,
    fontSize: fontSizes.xs,
  },
  commentBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  commentText: {
    color: colors.textMuted,
    fontSize: fontSizes.xs,
  },
  labels: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginTop: 4,
  },
  label: {
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderWidth: 1,
  },
  labelText: {
    fontSize: fontSizes.xs,
    fontWeight: fontWeights.medium,
  },
});
