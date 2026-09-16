import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { stampedByTenant } from '../core/tenancy/tenant-stamped';
import { PrismaService } from '../core/persistence/prisma.service';
import type { INotificationRepository } from './notification.repository';
import type { NotificationRequest, NotificationView } from './notification.types';

const SELECT = {
  id: true,
  kind: true,
  title: true,
  body: true,
  linkPath: true,
  readAt: true,
  createdAt: true,
} as const;

@Injectable()
export class PrismaNotificationRepository implements INotificationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(request: NotificationRequest): Promise<NotificationView> {
    const row = await this.prisma.client.notification.create({
      data: stampedByTenant<Prisma.NotificationUncheckedCreateInput>({
        kind: request.kind,
        title: request.title,
        body: request.body,
        linkPath: request.linkPath ?? null,
      }),
      select: SELECT,
    });
    return row;
  }

  async list(input: { unreadOnly: boolean; limit: number }): Promise<NotificationView[]> {
    const rows = await this.prisma.client.notification.findMany({
      where: input.unreadOnly ? { readAt: null } : {},
      orderBy: { createdAt: 'desc' },
      take: input.limit,
      select: SELECT,
    });
    return rows;
  }

  countUnread(): Promise<number> {
    return this.prisma.client.notification.count({ where: { readAt: null } });
  }

  /**
   * updateMany, not update.
   *
   * `update` on a primary key would have the tenant extension add clientId to a
   * unique where clause, which Prisma rejects; more importantly, a plain
   * `update` throws P2025 for "not yours" and "does not exist" alike, and
   * turning that into a 404 means the error path decides the response. Doing it
   * as a scoped updateMany makes "another Client's id" indistinguishable from
   * "no such id" by construction, which is the answer we want to give anyway.
   */
  async markRead(id: string): Promise<NotificationView | null> {
    await this.prisma.client.notification.updateMany({
      where: { id, readAt: null },
      data: { readAt: new Date() },
    });

    // Read back rather than trusting the update count: zero rows updated also
    // means "already read", which is a success, not a 404.
    const row = await this.prisma.client.notification.findFirst({
      where: { id },
      select: SELECT,
    });
    return (row) ?? null;
  }

  async markAllRead(): Promise<number> {
    const { count } = await this.prisma.client.notification.updateMany({
      where: { readAt: null },
      data: { readAt: new Date() },
    });
    return count;
  }
}
