import React, { useCallback } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { colors } from '../theme/colors';
import type { Issue } from '../api/issues';

interface IssueRowProps {
  issue: Issue;
  onPress: (issue: Issue) => void;
}

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

export function IssueRow({ issue, onPress }: IssueRowProps): React.ReactElement {
  const handlePress = useCallback(() => onPress(issue), [issue, onPress]);

  const stateColor = issue.state === 'open' ? colors.accent : colors.accentRed;

  return (
    <TouchableOpacity
      style={styles.row}
      onPress={handlePress}
      activeOpacity={0.75}
    >
      <View style={[styles.stateIndicator, { backgroundColor: stateColor }]} />

      <View style={styles.content}>
        <View style={styles.titleRow}>
          <Text style={styles.title} numberOfLines={2}>
            {issue.title}
          </Text>
        </View>

        {issue.labels.length > 0 && (
          <View style={styles.labels}>
            {issue.labels.slice(0, 4).map((label) => (
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

        <View style={styles.meta}>
          <Text style={styles.metaText}>
            #{issue.number} opened {formatRelative(issue.createdAt)} by {issue.authorUsername}
          </Text>
          {issue.commentCount > 0 && (
            <View style={styles.commentCount}>
              <Text style={styles.metaIcon}>💬</Text>
              <Text style={styles.metaText}>{issue.commentCount}</Text>
            </View>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    backgroundColor: colors.bgSecondary,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingVertical: 12,
    paddingHorizontal: 16,
    gap: 12,
  },
  stateIndicator: {
    width: 14,
    height: 14,
    borderRadius: 7,
    marginTop: 3,
    flexShrink: 0,
  },
  content: {
    flex: 1,
    gap: 6,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  title: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.text,
    lineHeight: 20,
    flex: 1,
  },
  labels: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  label: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 20,
    borderWidth: 1,
  },
  labelText: {
    fontSize: 11,
    fontWeight: '500',
  },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  metaText: {
    fontSize: 12,
    color: colors.textMuted,
  },
  commentCount: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  metaIcon: {
    fontSize: 11,
  },
});
