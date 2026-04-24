import { fetchJSON, postJSON } from './client';

export type NotificationType =
  | 'issue_opened'
  | 'issue_closed'
  | 'issue_comment'
  | 'pr_opened'
  | 'pr_merged'
  | 'pr_closed'
  | 'pr_comment'
  | 'pr_review'
  | 'push'
  | 'star'
  | 'fork'
  | 'gate_failed'
  | 'gate_passed'
  | 'mention';

export interface Notification {
  id: string;
  userId: string;
  type: NotificationType;
  title: string;
  body: string | null;
  repoOwner: string | null;
  repoName: string | null;
  resourceUrl: string | null;
  isRead: boolean;
  createdAt: string;
}

export interface NotificationCounts {
  total: number;
  unread: number;
}

/** List notifications for the authenticated user. */
export async function listNotifications(
  filter: 'unread' | 'all' = 'unread',
  page = 1,
): Promise<Notification[]> {
  return fetchJSON<Notification[]>(
    `/notifications?filter=${filter}&page=${page}&json=1`,
  );
}

/** Get the unread notification count. */
export async function getNotificationCounts(): Promise<NotificationCounts> {
  return fetchJSON<NotificationCounts>('/notifications/counts?json=1');
}

/** Mark a single notification as read. */
export async function markNotificationRead(id: string): Promise<void> {
  await postJSON(`/notifications/${encodeURIComponent(id)}/read`, {});
}

/** Mark all notifications as read. */
export async function markAllRead(): Promise<void> {
  await postJSON('/notifications/mark-all-read', {});
}

/** Delete a notification. */
export async function deleteNotification(id: string): Promise<void> {
  await postJSON(`/notifications/${encodeURIComponent(id)}/delete`, {});
}

/** Clear all read notifications. */
export async function clearReadNotifications(): Promise<void> {
  await postJSON('/notifications/clear-read', {});
}
