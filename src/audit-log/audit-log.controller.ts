import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../core/persistence/prisma.service';
import { Roles } from '../identity/auth/decorators/roles.decorator';
import { AuditEventDto, AuditQueryDto } from './dto/audit-log.dto';

/**
 * The Client's own access log: every disclosure, every credential reveal, every
 * decision to share a password without rotating it.
 *
 * Client-only, and surfaced in the dashboard rather than buried in settings —
 * PRD §7.4 is specific that the Client should see this "without having to go
 * looking for it".
 */
@ApiTags('audit')
@Controller('audit')
@Roles('CLIENT')
export class AuditLogController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'This Client’s access and disclosure log' })
  async list(@Query() query: AuditQueryDto): Promise<AuditEventDto[]> {
    return this.prisma.client.auditEvent.findMany({
      where: query.action ? { action: query.action } : {},
      orderBy: { createdAt: 'desc' },
      take: query.limit ?? 50,
      select: {
        id: true,
        action: true,
        actorType: true,
        actorId: true,
        subjectType: true,
        subjectId: true,
        metadata: true,
        ipAddress: true,
        createdAt: true,
      },
    });
  }
}
