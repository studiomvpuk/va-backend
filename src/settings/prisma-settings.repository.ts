import { Injectable } from '@nestjs/common';
import { PrismaService } from '../core/persistence/prisma.service';
import { currentTenant } from '../core/tenancy/tenant.context';
import type { ClientSettingsView, ISettingsRepository } from './settings.repository';

const SELECT = {
  minFitScore: true,
  gapMode: true,
  byokEnabled: true,
  whatsappEnabled: true,
} as const;

interface Row {
  minFitScore: { toString(): string };
  gapMode: string;
  byokEnabled: boolean;
  whatsappEnabled: boolean;
}

/** Decimal(3,1) comes back as a Prisma Decimal, not a number. */
function toView(row: Row): ClientSettingsView {
  return {
    minFitScore: Number(row.minFitScore.toString()),
    gapMode: row.gapMode as ClientSettingsView['gapMode'],
    byokEnabled: row.byokEnabled,
    whatsappEnabled: row.whatsappEnabled,
  };
}

@Injectable()
export class PrismaSettingsRepository implements ISettingsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async get(): Promise<ClientSettingsView> {
    const clientId = this.requireTenant();
    // Registration creates the row, but upsert keeps this total rather than
    // making every caller handle a null that should not occur.
    const row = await this.prisma.client.clientSettings.upsert({
      where: { clientId },
      create: { clientId },
      update: {},
      select: SELECT,
    });
    return toView(row);
  }

  async update(changes: Partial<ClientSettingsView>): Promise<ClientSettingsView> {
    const clientId = this.requireTenant();
    const row = await this.prisma.client.clientSettings.upsert({
      where: { clientId },
      create: { clientId, ...changes },
      update: changes,
      select: SELECT,
    });
    return toView(row);
  }

  private requireTenant(): string {
    const clientId = currentTenant()?.clientId;
    if (!clientId) throw new Error('No tenant context for a settings operation');
    return clientId;
  }
}
