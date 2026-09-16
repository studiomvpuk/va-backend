import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { stampedByTenant } from '../tenancy/tenant-stamped';
import { PrismaService } from '../persistence/prisma.service';
import { currentTenant } from '../tenancy/tenant.context';
import type { AuditEntry, IAuditLogger } from './audit.interface';

type TxClient = { auditEvent: { create: (args: unknown) => Promise<unknown> } };

@Injectable()
export class AuditService implements IAuditLogger {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry, tx?: unknown): Promise<void> {
    const tenant = currentTenant();
    const actorType = entry.actor?.type ?? tenant?.actorType ?? 'SYSTEM';
    const actorId = entry.actor?.id ?? tenant?.actorId ?? 'system';

    const db = (tx as TxClient | undefined) ?? this.prisma.client;

    await db.auditEvent.create({
      data: stampedByTenant<Prisma.AuditEventUncheckedCreateInput>({
        actorType,
        actorId,
        action: entry.action,
        subjectType: entry.subjectType,
        subjectId: entry.subjectId,
        // AuditEntry.metadata is a plain Record so the domain interface stays
        // free of Prisma types; Prisma wants its own Json input type here.
        metadata: (entry.metadata ?? {}) as Prisma.InputJsonObject,
        ipAddress: entry.ipAddress ?? null,
      }),
    });
  }
}
