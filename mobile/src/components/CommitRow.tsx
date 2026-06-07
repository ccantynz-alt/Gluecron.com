import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors } from '../theme/colors';
import { fontSizes, fontWeights, fonts } from '../theme/typography';
import { type Commit } from '../api/client';

interface Props {
  commit: Commit;
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

export function CommitRow({ commit }: Props) {
  const shortSha = commit.sha.slice(0, 7);
  const subject = commit.message.split('\n')[0];

  return (
    <View style={styles.row}>
      <View style={styles.content}>
        <Text style={styles.message} numberOfLines={2}>
          {subject}
        </Text>
        <View style={styles.meta}>
          <Text style={styles.sha}>{shortSha}</Text>
          <Text style={styles.author}>{commit.author.name}</Text>
          <Text style={styles.time}>{timeAgo(commit.author.date)}</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  content: {
    gap: 4,
  },
  message: {
    color: colors.text,
    fontSize: fontSizes.sm,
    fontWeight: fontWeights.regular,
    lineHeight: 18,
  },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  sha: {
    color: colors.accent,
    fontSize: fontSizes.xs,
    fontFamily: fonts.mono,
    fontWeight: fontWeights.medium,
  },
  author: {
    color: colors.textMuted,
    fontSize: fontSizes.xs,
  },
  time: {
    color: colors.textMuted,
    fontSize: fontSizes.xs,
  },
});
