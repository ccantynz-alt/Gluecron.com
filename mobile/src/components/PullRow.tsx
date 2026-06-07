import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { colors } from '../theme/colors';
import { fontSizes, fontWeights } from '../theme/typography';
import { type PullRequest } from '../api/client';

interface Props {
  pull: PullRequest;
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

function stateColor(state: string): string {
  switch (state) {
    case 'open': return colors.green;
    case 'merged': return colors.accent;
    case 'closed': return colors.red;
    default: return colors.textMuted;
  }
}

function stateLabel(state: string): string {
  switch (state) {
    case 'open': return 'Open';
    case 'merged': return 'Merged';
    case 'closed': return 'Closed';
    default: return state;
  }
}

export function PullRow({ pull, onPress }: Props) {
  return (
    <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.75}>
      <View style={[styles.stateDot, { backgroundColor: stateColor(pull.state) }]} />

      <View style={styles.content}>
        <Text style={styles.title} numberOfLines={2}>
          {pull.title}
        </Text>

        <View style={styles.meta}>
          <Text style={styles.number}>#{pull.number}</Text>
          <View style={[styles.stateBadge, { backgroundColor: stateColor(pull.state) + '22', borderColor: stateColor(pull.state) }]}>
            <Text style={[styles.stateText, { color: stateColor(pull.state) }]}>{stateLabel(pull.state)}</Text>
          </View>
          <Text style={styles.branches}>
            {pull.headBranch} → {pull.baseBranch}
          </Text>
        </View>

        <Text style={styles.time}>opened {timeAgo(pull.createdAt)}</Text>
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
  stateDot: {
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
  stateBadge: {
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderWidth: 1,
  },
  stateText: {
    fontSize: fontSizes.xs,
    fontWeight: fontWeights.medium,
  },
  branches: {
    color: colors.textMuted,
    fontSize: fontSizes.xs,
    fontFamily: 'monospace',
  },
  time: {
    color: colors.textMuted,
    fontSize: fontSizes.xs,
  },
});
