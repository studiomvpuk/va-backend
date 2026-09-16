import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../core/persistence/prisma.service';
import { stampedByTenant } from '../core/tenancy/tenant-stamped';
import { isUniqueViolation } from '../core/persistence/prisma-errors';
import {
  SiteNameTakenError,
  type ISiteRepository,
  type SiteView,
  type VaRecordForGate,
} from './site.repository';

const SELECT = {
  id: true,
  name: true,
  url: true,
  username: true,
  status: true,
  createdAt: true,
} as const;

@Injectable()
export class PrismaSiteRepository implements ISiteRepository {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<SiteView[]> {
    return this.prisma.client.site.findMany({
      select: SELECT,
      orderBy: { createdAt: 'asc' },
    });
  }

  async find(id: string): Promise<SiteView | null> {
    return this.prisma.client.site.findUnique({
      where: { id },
      select: SELECT,
    });
  }

  async create(input: {
    name: string;
    url: string;
    username: string;
  }): Promise<SiteView> {
    try {
      return await this.prisma.client.site.create({
        data: stampedByTenant<Prisma.SiteUncheckedCreateInput>(input),
        select: SELECT,
      });
    } catch (e) {
      // @@unique([clientId, name]). The Client is adding a site they already
      // have — their mistake to correct, not a failure of ours to report.
      if (isUniqueViolation(e)) throw new SiteNameTakenError(input.name);
      throw e;
    }
  }

  async update(
    id: string,
    changes: { name?: string; url?: string; username?: string },
  ): Promise<SiteView> {
    try {
      return await this.prisma.client.site.update({
        where: { id },
        data: changes,
        select: SELECT,
      });
    } catch (e) {
      // Renaming onto a name already in use hits the same constraint.
      if (isUniqueViolation(e) && changes.name) {
        throw new SiteNameTakenError(changes.name);
      }
      throw e;
    }
  }

  async remove(id: string): Promise<void> {
    await this.prisma.client.site.delete({ where: { id } });
  }

  async findVa(vaId: string): Promise<VaRecordForGate | null> {
    return this.prisma.client.virtualAssistant.findUnique({
      where: { id: vaId },
      select: { id: true, createdAt: true, revokedAt: true },
    });
  }
}
