import React, { useCallback } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { colors } from '../theme/colors';
import type { CommitEntry } from '../api/repos';

interface CommitRowProps {
  commit: CommitEntry;
  onPress?: (commit: CommitEntry) => void;
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

function shortMessage(msg: string): string {
  const firstLine = msg.split('\n')[0] ?? msg;
  if (firstLine.length <= 72) return firstLine;
  return firstLine.slice(0, 69) + '...';
}

export function CommitRow({ commit, onPress }: CommitRowProps): React.ReactElement {
  const handlePress = useCallback(() => onPress?.(commit), [commit, onPress]);

  return (
    <TouchableOpacity
      style={styles.row}
      onPress={handlePress}
      activeOpacity={onPress !== undefined ? 0.75 : 1}
    >
      <View style={styles.content}>
        <Text style={styles.message} numberOfLines={2}>
          {shortMessage(commit.message)}
        </Text>
        <View style={styles.meta}>
          <Text style={styles.author}>{commit.authorName}</Text>
          <Text style={styles.dot}>·</Text>
          <Text style={styles.metaText}>{formatRelative(commit.authorDate)}</Text>
        </View>
      </View>
      <View style={styles.shaContainer}>
        <Text style={styles.sha}>{commit.sha.slice(0, 7)}</Text>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgSecondary,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingVertical: 12,
    paddingHorizontal: 16,
    gap: 12,
  },
  content: {
    flex: 1,
    gap: 4,
  },
  message: {
    fontSize: 14,
    color: colors.text,
    lineHeight: 20,
  },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  author: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.textMuted,
  },
  dot: {
    fontSize: 12,
    color: colors.textMuted,
  },
  metaText: {
    fontSize: 12,
    color: colors.textMuted,
  },
  shaContainer: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    backgroundColor: colors.bgTertiary,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colors.border,
  },
  sha: {
    fontSize: 12,
    fontFamily: 'monospace',
    color: colors.textLink,
  },
});
