import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { colors } from '../theme/colors';
import { fontSizes, fontWeights } from '../theme/typography';
import { type Repository } from '../api/client';

interface Props {
  repo: Repository;
  ownerUsername?: string;
  onPress: () => void;
}

const LANG_COLORS: Record<string, string> = {
  TypeScript: '#3178c6',
  JavaScript: '#f1e05a',
  Python: '#3572A5',
  Go: '#00ADD8',
  Rust: '#dea584',
  Ruby: '#701516',
  Java: '#b07219',
  'C++': '#f34b7d',
  C: '#555555',
  Swift: '#F05138',
  Kotlin: '#A97BFF',
  PHP: '#4F5D95',
  'C#': '#239120',
  Shell: '#89e051',
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

export function RepoCard({ repo, ownerUsername, onPress }: Props) {
  const langColor = repo.language ? (LANG_COLORS[repo.language] ?? colors.textMuted) : colors.textMuted;

  return (
    <TouchableOpacity style={styles.card} onPress={onPress} activeOpacity={0.75}>
      <View style={styles.header}>
        <Text style={styles.name} numberOfLines={1}>
          {ownerUsername ? `${ownerUsername}/` : ''}
          <Text style={styles.repoName}>{repo.name}</Text>
        </Text>
        {repo.isPrivate && (
          <View style={styles.privateBadge}>
            <Text style={styles.privateBadgeText}>private</Text>
          </View>
        )}
      </View>

      {repo.description ? (
        <Text style={styles.desc} numberOfLines={2}>
          {repo.description}
        </Text>
      ) : null}

      <View style={styles.meta}>
        {repo.language && (
          <View style={styles.langRow}>
            <View style={[styles.langDot, { backgroundColor: langColor }]} />
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
        <Text style={styles.metaTime}>{timeAgo(repo.updatedAt)}</Text>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bgSurface,
    borderRadius: 10,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
    gap: 8,
  },
  name: {
    flex: 1,
    fontSize: fontSizes.base,
    color: colors.textMuted,
    fontWeight: fontWeights.regular,
  },
  repoName: {
    color: colors.accent,
    fontWeight: fontWeights.semibold,
  },
  privateBadge: {
    backgroundColor: colors.accentDim,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  privateBadgeText: {
    color: colors.accent,
    fontSize: fontSizes.xs,
    fontWeight: fontWeights.medium,
  },
  desc: {
    color: colors.textMuted,
    fontSize: fontSizes.sm,
    lineHeight: 18,
    marginBottom: 10,
  },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flexWrap: 'wrap',
  },
  langRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  langDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  metaItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  metaIcon: {
    color: colors.textMuted,
    fontSize: fontSizes.xs,
  },
  metaText: {
    color: colors.textMuted,
    fontSize: fontSizes.xs,
  },
  metaTime: {
    color: colors.textMuted,
    fontSize: fontSizes.xs,
    marginLeft: 'auto',
  },
});
