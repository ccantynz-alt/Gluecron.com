import { useState, useCallback } from 'react';
import { api, type ActivityEvent } from '../api/client';

export interface Notification {
  id: string;
  type: string;
  title: string;
  subtitle: string;
  read: boolean;
  createdAt: string;
  repoOwner?: string;
  repoName?: string;
}

function activityToNotification(event: ActivityEvent & { repoOwner?: string; repoName?: string }): Notification {
  const type = event.type || 'activity';
  const payload = event.payload as Record<string, unknown>;

  let title = 'Activity';
  let subtitle = '';

  switch (type) {
    case 'push':
      title = 'Push';
      subtitle = `${payload.ref ?? 'branch'} updated`;
      break;
    case 'issue.opened':
      title = 'Issue opened';
      subtitle = String(payload.title ?? '');
      break;
    case 'issue.closed':
      title = 'Issue closed';
      subtitle = String(payload.title ?? '');
      break;
    case 'pr.opened':
      title = 'PR opened';
      subtitle = String(payload.title ?? '');
      break;
    case 'pr.merged':
      title = 'PR merged';
      subtitle = String(payload.title ?? '');
      break;
    case 'star':
      title = 'New star';
      subtitle = String(payload.username ?? 'Someone') + ' starred the repo';
      break;
    default:
      title = type.replace(/[._]/g, ' ');
      subtitle = '';
  }

  return {
    id: event.id,
    type,
    title,
    subtitle,
    read: false,
    createdAt: event.createdAt,
    repoOwner: event.repoOwner,
    repoName: event.repoName,
  };
}

// Notifications are synthesized from activity feeds across user repos.
// The Gluecron REST API doesn't expose a dedicated /notifications endpoint,
// so we aggregate from the repos the user cares about.
export function useNotifications(repos: Array<{ owner: string; name: string }>) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    if (repos.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      const results = await Promise.allSettled(
        repos.slice(0, 5).map((r) =>
          api.getRepoActivity(r.owner, r.name, 10).then((events) =>
            events.map((e) => activityToNotification({ ...e, repoOwner: r.owner, repoName: r.name }))
          )
        )
      );

      const allNotifs: Notification[] = [];
      for (const r of results) {
        if (r.status === 'fulfilled') {
          allNotifs.push(...r.value);
        }
      }

      // Sort newest first
      allNotifs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      setNotifications(allNotifs.slice(0, 50));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load notifications');
    } finally {
      setLoading(false);
    }
  }, [repos]);

  const markAllRead = useCallback(() => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  }, []);

  const unreadCount = notifications.filter((n) => !n.read).length;

  return { notifications, loading, error, refresh: fetch, markAllRead, unreadCount };
}
