import { Body, Controller, Get, Inject, Param, Patch, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { Roles } from '../identity/auth/decorators/roles.decorator';
import {
  APPLICATION_REPOSITORY,
  type AppStatus,
  type IApplicationRepository,
} from './application.repository';
import { PrepService } from '../prep/prep.service';

const STATUSES = [
  'SCORED', 'SKIPPED', 'IN_PROGRESS', 'BLOCKED',
  'APPLIED', 'INTERVIEW', 'REJECTED', 'OFFER',
] as const;

export class ListApplicationsDto {
  @ApiPropertyOptional({ enum: STATUSES })
  @IsOptional()
  @IsIn([...STATUSES])
  status?: AppStatus;

  @ApiPropertyOptional({ default: 50, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class UpdateStatusDto {
  @ApiPropertyOptional({ enum: STATUSES })
  @IsIn([...STATUSES])
  status!: AppStatus;
}

@ApiTags('applications')
@Controller('applications')
@Roles('CLIENT')
export class ApplicationsController {
  constructor(
    @Inject(APPLICATION_REPOSITORY) private readonly applications: IApplicationRepository,
    private readonly prep: PrepService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'The applications tracker' })
  async list(@Query() query: ListApplicationsDto) {
    return this.applications.list(query);
  }

  @Get('stats')
  @ApiOperation({
    summary: 'The four dashboard figures',
    description:
      'Aggregated in the database. The tracker is paginated, so these cannot ' +
      'be derived from a page of it.',
  })
  async stats() {
    return this.applications.stats();
  }

  @Get(':id')
  @ApiOperation({ summary: 'One application, with its fit reasoning' })
  async find(@Param('id') id: string) {
    return this.applications.find(id);
  }

  @Patch(':id/status')
  @ApiOperation({
    summary: 'Move an application along',
    description:
      'Marking INTERVIEW queues interview prep and returns immediately. The ' +
      'document arrives at applications/:id/prep with an in-app notification.',
  })
  async updateStatus(@Param('id') id: string, @Body() dto: UpdateStatusDto) {
    const application = await this.applications.updateStatus(id, dto.status);

    // Enqueue only — `request` holds a queue, not a composer, so there is no
    // way for this line to become a thirty-second web search on a PATCH.
    if (dto.status === 'INTERVIEW') {
      await this.prep.request(id);
    }

    return application;
  }
}
