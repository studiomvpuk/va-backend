import { Inject, Injectable } from '@nestjs/common';
import { ChannelDispatcher, type ChannelOutcome } from './channel-dispatcher';
import {
  NOTIFICATION_REPOSITORY,
  type INotificationRepository,
} from './notification.repository';
import type { NotificationRequest, NotificationView } from './notification.types';
import { PrismaService } from '../core/persistence/prisma.service';
import { currentTenant } from '../core/tenancy/tenant.context';

/**
 * The only way anything in this application tells the Client something.
 *
 * Two steps, in this order, and the order is the design:
 *
 *   1. Write the in-app row. This is the durable record. If it fails, the call
 *      fails — a notification nobody can find later is worse than an error the
 *      caller can react to.
 *   2. Fan out to every other channel, best-effort, without blocking.
 *
 * Nothing else in the codebase writes to the Notification table or sends an
 * email, so "the Client was told" has exactly one meaning and exactly one place
 * it can be verified.
 */
@Injectable()
export class NotificationService {
  constructor(
    @Inject(NOTIFICATION_REPOSITORY)
    private readonly repository: INotificationRepository,
    private readonly dispatcher: ChannelDispatcher,
    private readonly prisma: PrismaService,
  ) {}

  async notify(request: NotificationRequest): Promise<NotificationView> {
    const notification = await this.repository.create(request);

    this.dispatcher.dispatch({
      notification,
      urgent: request.urgent,
      clientEmail: await this.clientEmail(),
    });

    return notification;
  }

  /**
   * Same thing, but waits for the channels.
   *
   * Used where the outcome is part of what the caller reports — the settings
   * screen's "send a test notification" button — and by tests. Regular product
   * code uses `notify`.
   */
  async notifyAndWait(request: NotificationRequest): Promise<{
    notification: NotificationView;
    outcomes: ChannelOutcome[];
  }> {
    const notification = await this.repository.create(request);
    const outcomes = await this.dispatcher.deliver({
      notification,
      urgent: request.urgent,
      clientEmail: await this.clientEmail(),
    });
    return { notification, outcomes };
  }

  list(input: { unreadOnly: boolean; limit: number }): Promise<NotificationView[]> {
    return this.repository.list(input);
  }

  countUnread(): Promise<number> {
    return this.repository.countUnread();
  }

  markRead(id: string): Promise<NotificationView | null> {
    return this.repository.markRead(id);
  }

  markAllRead(): Promise<number> {
    return this.repository.markAllRead();
  }

  /**
   * Read fresh each time rather than cached on the request.
   *
   * A Client who corrects their email address should have the next notification
   * go to the new one, and notifications outlive the request that triggered
   * them — a background drafting job may notify long after any login.
   *
   * ── The explicit id is not optional ─────────────────────────────────────────
   * `Client` is the tenant, not a tenant-scoped model: it has `id`, not
   * `clientId`, so the Prisma extension adds nothing to this query. A bare
   * findFirst here would return SOMEBODY's email — very likely the wrong
   * person's — and mail them another Client's notification. So the id comes
   * from the tenant context by hand, and a missing context throws rather than
   * guessing.
   */
  private async clientEmail(): Promise<string> {
    const clientId = currentTenant()?.clientId;
    if (!clientId) {
      throw new Error('cannot notify without a tenant in context');
    }

    const row = await this.prisma.client.client.findUnique({
      where: { id: clientId },
      select: { email: true },
    });
    return row?.email ?? '';
  }
}
