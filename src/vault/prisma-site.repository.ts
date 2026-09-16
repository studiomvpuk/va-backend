import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../core/persistence/prisma.service';
import { stampedByTenant } from '../core/tenancy/tenant-stamped';
import type {
  ISiteRepository,
  SiteView,
  VaRecordForGate,
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
    return this.prisma.client.site.create({
      data: stampedByTenant<Prisma.SiteUncheckedCreateInput>(input),
      select: SELECT,
    });
  }

  async update(
    id: string,
    changes: { name?: string; url?: string; username?: string },
  ): Promise<SiteView> {
    return this.prisma.client.site.update({
      where: { id },
      data: changes,
      select: SELECT,
    });
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
