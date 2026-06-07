import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { colors } from '../theme/colors';
import { fontSizes, fontWeights } from '../theme/typography';
import { type Notification } from '../hooks/useNotifications';

interface Props {
  notification: Notification;
  onPress?: () => void;
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

function typeIcon(type: string): string {
  if (type.startsWith('issue')) return '●';
  if (type.startsWith('pr')) return '⑂';
  if (type === 'push') return '↑';
  if (type === 'star') return '★';
  return '◈';
}

function typeColor(type: string): string {
  if (type.startsWith('issue')) return colors.green;
  if (type.startsWith('pr')) return colors.accent;
  if (type === 'push') return colors.blue;
  if (type === 'star') return colors.yellow;
  return colors.textMuted;
}

export function NotifRow({ notification, onPress }: Props) {
  const icon = typeIcon(notification.type);
  const iconColor = typeColor(notification.type);

  return (
    <TouchableOpacity style={[styles.row, !notification.read && styles.unread]} onPress={onPress} activeOpacity={0.75}>
      <View style={styles.iconWrap}>
        <Text style={[styles.icon, { color: iconColor }]}>{icon}</Text>
      </View>

      <View style={styles.content}>
        <View style={styles.header}>
          <Text style={styles.title} numberOfLines={1}>
            {notification.title}
          </Text>
          {!notification.read && <View style={styles.unreadDot} />}
        </View>
        {notification.subtitle ? (
          <Text style={styles.subtitle} numberOfLines={1}>{notification.subtitle}</Text>
        ) : null}
        <View style={styles.footer}>
          {notification.repoOwner && notification.repoName && (
            <Text style={styles.repo}>{notification.repoOwner}/{notification.repoName}</Text>
          )}
          <Text style={styles.time}>{timeAgo(notification.createdAt)}</Text>
        </View>
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
  unread: {
    backgroundColor: colors.bgSecondary,
  },
  iconWrap: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.bgSurface,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  icon: {
    fontSize: 14,
  },
  content: {
    flex: 1,
    gap: 3,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  title: {
    color: colors.text,
    fontSize: fontSizes.base,
    fontWeight: fontWeights.medium,
    flex: 1,
  },
  unreadDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: colors.accent,
    flexShrink: 0,
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: fontSizes.sm,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 2,
  },
  repo: {
    color: colors.textMuted,
    fontSize: fontSizes.xs,
    flex: 1,
  },
  time: {
    color: colors.textMuted,
    fontSize: fontSizes.xs,
  },
});
