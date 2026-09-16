import type { NotificationRequest, NotificationView } from './notification.types';

export interface INotificationRepository {
  create(request: NotificationRequest): Promise<NotificationView>;
  list(input: { unreadOnly: boolean; limit: number }): Promise<NotificationView[]>;
  countUnread(): Promise<number>;
  /** Returns null when the id belongs to another Client — see the note below. */
  markRead(id: string): Promise<NotificationView | null>;
  markAllRead(): Promise<number>;
}

export const NOTIFICATION_REPOSITORY = Symbol('NOTIFICATION_REPOSITORY');
