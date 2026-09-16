import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { tenantScopedExtension } from '../tenancy/tenant-scoped.extension';

/**
 * The tenant-scoped Prisma client.
 *
 * Every consumer in the application injects this. The raw PrismaClient is not
 * exported anywhere, so there is no ambient way to issue an unscoped query —
 * that is the point.
 */
function createClient() {
  return new PrismaClient({
    log:
      process.env.NODE_ENV === 'development'
        ? ['warn', 'error']
        : ['error'],
  }).$extends(tenantScopedExtension);
}

export type ExtendedPrismaClient = ReturnType<typeof createClient>;

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  public readonly client: ExtendedPrismaClient = createClient();

  async onModuleInit(): Promise<void> {
    await this.client.$connect();
    this.logger.log('Database connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
