import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../identity/auth/decorators/public.decorator';
import { runWithoutTenantScope } from '../core/tenancy/tenant.context';
import { PrismaService } from '../core/persistence/prisma.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  // Public: a load balancer's health probe carries no token, and refusing
  // one looks exactly like an outage.
  @Public()
  @Get()
  @ApiOperation({ summary: 'Liveness and database reachability' })
  async check(): Promise<{ status: string; database: string }> {
    // Health checks legitimately run outside any tenant — named explicitly
    // rather than slipping past the isolation mechanism silently.
    const database = await runWithoutTenantScope(async () => {
      try {
        await this.prisma.client.$queryRaw`SELECT 1`;
        return 'up';
      } catch {
        return 'down';
      }
    });

    return { status: database === 'up' ? 'ok' : 'degraded', database };
  }
}
