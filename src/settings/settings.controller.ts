import { Body, Controller, Get, Inject, Patch } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../identity/auth/decorators/roles.decorator';
import { AUDIT_LOGGER, type IAuditLogger } from '../core/audit/audit.interface';
import { SETTINGS_REPOSITORY, type ISettingsRepository } from './settings.repository';
import { SettingsDto, UpdateSettingsDto } from './dto/settings.dto';

@ApiTags('settings')
@Controller('settings')
@Roles('CLIENT')
export class SettingsController {
  constructor(
    @Inject(SETTINGS_REPOSITORY) private readonly settings: ISettingsRepository,
    @Inject(AUDIT_LOGGER) private readonly audit: IAuditLogger,
  ) {}

  @Get()
  @ApiOperation({ summary: 'This Client’s settings' })
  async get(): Promise<SettingsDto> {
    return this.settings.get();
  }

  @Patch()
  @ApiOperation({ summary: 'Update settings' })
  async update(@Body() dto: UpdateSettingsDto): Promise<SettingsDto> {
    const changes: Partial<SettingsDto> = {};

    // Rounded to the nearest half point so the stored value always matches a
    // slider position — otherwise the UI shows 6.0 while the rubric uses 6.03.
    if (dto.minFitScore !== undefined) {
      changes.minFitScore = Math.round(dto.minFitScore * 2) / 2;
    }
    if (dto.gapMode !== undefined) changes.gapMode = dto.gapMode;
    if (dto.byokEnabled !== undefined) changes.byokEnabled = dto.byokEnabled;

    const updated = await this.settings.update(changes as never);

    // Both of these change who pays and what happens when the AI is unsure —
    // worth a record, and cheap to keep.
    if (dto.gapMode !== undefined || dto.byokEnabled !== undefined) {
      await this.audit.record({
        action: 'settings.changed',
        subjectType: 'ClientSettings',
        subjectId: 'self',
        metadata: {
          ...(dto.gapMode !== undefined ? { gapMode: dto.gapMode } : {}),
          ...(dto.byokEnabled !== undefined ? { byokEnabled: dto.byokEnabled } : {}),
        },
      });
    }

    return updated;
  }
}
