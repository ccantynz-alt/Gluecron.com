import React, { useCallback, useEffect, useState } from 'react';
import {
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  listNotifications,
  markNotificationRead,
  markAllRead,
} from '../api/notifications';
import type { Notification } from '../api/notifications';
import { LoadingSpinner } from '../components/LoadingSpinner';
import { ErrorBanner } from '../components/ErrorBanner';
import { colors } from '../theme/colors';

function typeIcon(type: Notification['type']): string {
  switch (type) {
    case 'issue_opened': return '○';
    case 'issue_closed': return '●';
    case 'issue_comment': return '💬';
    case 'pr_opened': return '⑂';
    case 'pr_merged': return '✓';
    case 'pr_closed': return '✗';
    case 'pr_comment': return '💬';
    case 'pr_review': return '✦';
    case 'push': return '↑';
    case 'star': return '★';
    case 'fork': return '⑂';
    case 'gate_failed': return '✗';
    case 'gate_passed': return '✓';
    case 'mention': return '@';
    default: return '•';
  }
}

function typeColor(type: Notification['type']): string {
  switch (type) {
    case 'gate_failed':
    case 'issue_closed':
    case 'pr_closed': return colors.accentRed;
    case 'gate_passed':
    case 'pr_merged': return colors.accentPurple;
    case 'pr_review': return colors.accentPurple;
    case 'star': return colors.accentYellow;
    default: return colors.accentBlue;
  }
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
  return `${Math.floor(days / 30)}mo ago`;
}

interface NotifRowProps {
  notif: Notification;
  onRead: (id: string) => void;
}

function NotifRow({ notif, onRead }: NotifRowProps): React.ReactElement {
  const handlePress = useCallback(() => {
    if (!notif.isRead) onRead(notif.id);
  }, [notif.id, notif.isRead, onRead]);

  const iconColor = typeColor(notif.type);

  return (
    <TouchableOpacity
      style={[styles.row, notif.isRead && styles.rowRead]}
      onPress={handlePress}
      activeOpacity={0.75}
    >
      <View style={[styles.iconContainer, { backgroundColor: iconColor + '22' }]}>
        <Text style={[styles.icon, { color: iconColor }]}>{typeIcon(notif.type)}</Text>
      </View>
      <View style={styles.content}>
        <Text style={styles.title} numberOfLines={2}>{notif.title}</Text>
        {notif.body !== null && (
          <Text style={styles.body} numberOfLines={1}>{notif.body}</Text>
        )}
        <View style={styles.meta}>
          {notif.repoOwner !== null && notif.repoName !== null && (
            <Text style={styles.repoText}>{notif.repoOwner}/{notif.repoName}</Text>
          )}
          <Text style={styles.time}>{formatRelative(notif.createdAt)}</Text>
        </View>
      </View>
      {!notif.isRead && <View style={styles.unreadDot} />}
    </TouchableOpacity>
  );
}

type FilterState = 'unread' | 'all';

export function NotificationsScreen(): React.ReactElement {
  const [filter, setFilter] = useState<FilterState>('unread');
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    listNotifications(filter)
      .then((data) => {
        if (!cancelled) setNotifications(data);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load notifications');
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [filter, tick]);

  const handleRead = useCallback(async (id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, isRead: true } : n)),
    );
    try {
      await markNotificationRead(id);
    } catch {/* ignore */}
  }, []);

  const handleMarkAllRead = useCallback(async () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
    try {
      await markAllRead();
      setTick((t) => t + 1);
    } catch {/* ignore */}
  }, []);

  const renderNotif = useCallback(
    ({ item }: { item: Notification }) => (
      <NotifRow notif={item} onRead={handleRead} />
    ),
    [handleRead],
  );

  const keyExtractor = useCallback((item: Notification) => item.id, []);
  const unreadCount = notifications.filter((n) => !n.isRead).length;

  if (isLoading && notifications.length === 0) return <LoadingSpinner fullScreen />;

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Notifications</Text>
        {unreadCount > 0 && (
          <TouchableOpacity onPress={handleMarkAllRead}>
            <Text style={styles.markAllText}>Mark all read</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Filter tabs */}
      <View style={styles.filterTabs}>
        <TouchableOpacity
          style={[styles.filterTab, filter === 'unread' && styles.filterTabActive]}
          onPress={() => setFilter('unread')}
        >
          <Text style={[styles.filterTabText, filter === 'unread' && styles.filterTabTextActive]}>
            Unread
            {unreadCount > 0 && ` (${unreadCount})`}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.filterTab, filter === 'all' && styles.filterTabActive]}
          onPress={() => setFilter('all')}
        >
          <Text style={[styles.filterTabText, filter === 'all' && styles.filterTabTextActive]}>
            All
          </Text>
        </TouchableOpacity>
      </View>

      {error !== null && <ErrorBanner message={error} onRetry={() => setTick((t) => t + 1)} />}

      <FlatList
        data={notifications}
        keyExtractor={keyExtractor}
        renderItem={renderNotif}
        style={styles.list}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyIcon}>🔔</Text>
            <Text style={styles.emptyText}>
              {filter === 'unread' ? "You're all caught up!" : 'No notifications'}
            </Text>
          </View>
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: colors.bgSecondary,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.text,
  },
  markAllText: {
    fontSize: 13,
    color: colors.textLink,
  },
  filterTabs: {
    flexDirection: 'row',
    backgroundColor: colors.bgSecondary,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  filterTab: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  filterTabActive: {
    borderBottomColor: colors.accentBlue,
  },
  filterTabText: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.textMuted,
  },
  filterTabTextActive: {
    color: colors.text,
  },
  list: {
    flex: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.bgSecondary,
    gap: 12,
  },
  rowRead: {
    opacity: 0.6,
    backgroundColor: colors.bg,
  },
  iconContainer: {
    width: 36,
    height: 36,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  icon: {
    fontSize: 16,
    fontWeight: '700',
  },
  content: {
    flex: 1,
    gap: 4,
  },
  title: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.text,
    lineHeight: 20,
  },
  body: {
    fontSize: 13,
    color: colors.textMuted,
  },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  repoText: {
    fontSize: 12,
    color: colors.textMuted,
    fontFamily: 'monospace',
  },
  time: {
    fontSize: 12,
    color: colors.textMuted,
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.accentBlue,
    marginTop: 6,
    flexShrink: 0,
  },
  emptyState: {
    padding: 48,
    alignItems: 'center',
    gap: 10,
  },
  emptyIcon: {
    fontSize: 36,
  },
  emptyText: {
    fontSize: 15,
    color: colors.textMuted,
    textAlign: 'center',
  },
});
