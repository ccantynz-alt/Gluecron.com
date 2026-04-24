import React, { useCallback } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { colors } from '../theme/colors';
import type { Repository } from '../api/repos';

interface RepoCardProps {
  repo: Repository;
  onPress: (repo: Repository) => void;
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

export function RepoCard({ repo, onPress }: RepoCardProps): React.ReactElement {
  const handlePress = useCallback(() => onPress(repo), [repo, onPress]);

  return (
    <TouchableOpacity
      style={styles.card}
      onPress={handlePress}
      activeOpacity={0.75}
    >
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Text style={styles.repoName} numberOfLines={1}>
            {repo.ownerUsername}/{repo.name}
          </Text>
          {repo.isPrivate && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>Private</Text>
            </View>
          )}
          {repo.isArchived && (
            <View style={[styles.badge, styles.badgeArchived]}>
              <Text style={styles.badgeText}>Archived</Text>
            </View>
          )}
          {repo.isFork && (
            <View style={[styles.badge, styles.badgeFork]}>
              <Text style={styles.badgeText}>Fork</Text>
            </View>
          )}
        </View>
        {repo.description !== null && repo.description.length > 0 && (
          <Text style={styles.description} numberOfLines={2}>
            {repo.description}
          </Text>
        )}
      </View>

      <View style={styles.footer}>
        {repo.language !== null && (
          <View style={styles.metaItem}>
            <View style={styles.langDot} />
            <Text style={styles.metaText}>{repo.language}</Text>
          </View>
        )}
        <View style={styles.metaItem}>
          <Text style={styles.metaIcon}>★</Text>
          <Text style={styles.metaText}>{repo.starCount}</Text>
        </View>
        <View style={styles.metaItem}>
          <Text style={styles.metaIcon}>⑂</Text>
          <Text style={styles.metaText}>{repo.forkCount}</Text>
        </View>
        {repo.openIssueCount > 0 && (
          <View style={styles.metaItem}>
            <Text style={styles.metaIcon}>○</Text>
            <Text style={styles.metaText}>{repo.openIssueCount}</Text>
          </View>
        )}
        <Text style={styles.updatedAt}>Updated {formatRelative(repo.updatedAt)}</Text>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bgSecondary,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 16,
    marginHorizontal: 16,
    marginBottom: 12,
  },
  header: {
    marginBottom: 12,
    gap: 6,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  repoName: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.textLink,
    flexShrink: 1,
  },
  description: {
    fontSize: 13,
    color: colors.textMuted,
    lineHeight: 18,
  },
  badge: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 20,
    backgroundColor: colors.bgTertiary,
    borderWidth: 1,
    borderColor: colors.border,
  },
  badgeArchived: {
    borderColor: colors.accentYellow,
  },
  badgeFork: {
    borderColor: colors.accentBlue,
  },
  badgeText: {
    fontSize: 11,
    color: colors.textMuted,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 12,
  },
  metaItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  langDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.accentPurple,
  },
  metaIcon: {
    fontSize: 12,
    color: colors.textMuted,
  },
  metaText: {
    fontSize: 12,
    color: colors.textMuted,
  },
  updatedAt: {
    fontSize: 12,
    color: colors.textMuted,
    marginLeft: 'auto',
  },
});
