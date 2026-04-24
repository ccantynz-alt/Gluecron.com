import React, { useCallback } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { colors } from '../theme/colors';
import type { PullRequest } from '../api/pulls';

interface PullRowProps {
  pr: PullRequest;
  onPress: (pr: PullRequest) => void;
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

function stateColor(state: PullRequest['state']): string {
  switch (state) {
    case 'open': return colors.accent;
    case 'merged': return colors.accentPurple;
    case 'closed': return colors.accentRed;
  }
}

function stateLabel(state: PullRequest['state']): string {
  switch (state) {
    case 'open': return 'Open';
    case 'merged': return 'Merged';
    case 'closed': return 'Closed';
  }
}

export function PullRow({ pr, onPress }: PullRowProps): React.ReactElement {
  const handlePress = useCallback(() => onPress(pr), [pr, onPress]);

  return (
    <TouchableOpacity
      style={styles.row}
      onPress={handlePress}
      activeOpacity={0.75}
    >
      <View style={[styles.stateIndicator, { backgroundColor: stateColor(pr.state) }]} />

      <View style={styles.content}>
        <View style={styles.titleRow}>
          <Text style={styles.title} numberOfLines={2}>
            {pr.title}
          </Text>
          {pr.isDraft && (
            <View style={styles.draftBadge}>
              <Text style={styles.draftText}>Draft</Text>
            </View>
          )}
        </View>

        <View style={styles.branchInfo}>
          <Text style={styles.branchText} numberOfLines={1}>
            {pr.headBranch}
          </Text>
          <Text style={styles.branchArrow}>→</Text>
          <Text style={styles.branchText} numberOfLines={1}>
            {pr.baseBranch}
          </Text>
        </View>

        <View style={styles.meta}>
          <Text style={styles.metaText}>
            #{pr.number} {stateLabel(pr.state)} {formatRelative(pr.createdAt)} by {pr.authorUsername}
          </Text>
          {pr.commentCount > 0 && (
            <View style={styles.commentCount}>
              <Text style={styles.metaIcon}>💬</Text>
              <Text style={styles.metaText}>{pr.commentCount}</Text>
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
    gap: 5,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  title: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.text,
    lineHeight: 20,
    flex: 1,
  },
  draftBadge: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 20,
    backgroundColor: colors.bgTertiary,
    borderWidth: 1,
    borderColor: colors.border,
    flexShrink: 0,
  },
  draftText: {
    fontSize: 11,
    color: colors.textMuted,
  },
  branchInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  branchText: {
    fontSize: 12,
    fontFamily: 'monospace',
    color: colors.textMuted,
    maxWidth: 120,
  },
  branchArrow: {
    fontSize: 12,
    color: colors.textMuted,
  },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  metaText: {
    fontSize: 12,
    color: colors.textMuted,
    flex: 1,
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
