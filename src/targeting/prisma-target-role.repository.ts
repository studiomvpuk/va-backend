import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { stampedByTenantMany } from '../core/tenancy/tenant-stamped';
import { PrismaService } from '../core/persistence/prisma.service';
import type {
  ITargetRoleRepository,
  TargetRoleView,
} from './target-role.repository';

const SELECT = { id: true, title: true, criteria: true } as const;

@Injectable()
export class PrismaTargetRoleRepository implements ITargetRoleRepository {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<TargetRoleView[]> {
    return this.prisma.client.targetRole.findMany({
      select: SELECT,
      orderBy: { title: 'asc' },
    });
  }

  /**
   * Replace-all rather than per-row CRUD.
   *
   * The UI is a single editable list — treating it as a set the Client owns
   * avoids the reconcile-diff dance for something that will never hold more
   * than a handful of rows.
   */
  async replaceAll(
    roles: { title: string; criteria?: string }[],
  ): Promise<TargetRoleView[]> {
    await this.prisma.client.targetRole.deleteMany({});
    if (roles.length > 0) {
      await this.prisma.client.targetRole.createMany({
        data: stampedByTenantMany<Prisma.TargetRoleUncheckedCreateInput>(
          roles.map((r) => ({ title: r.title, criteria: r.criteria ?? null })),
        ),
      });
    }
    return this.list();
  }
}
