import { Body, Controller, Get, Inject, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../identity/auth/decorators/roles.decorator';
import {
  TARGET_ROLE_REPOSITORY,
  type ITargetRoleRepository,
} from './target-role.repository';
import { ReplaceTargetRolesDto, TargetRoleDto } from './dto/target-role.dto';

@ApiTags('targeting')
@Controller('target-roles')
@Roles('CLIENT')
export class TargetingController {
  constructor(
    @Inject(TARGET_ROLE_REPOSITORY) private readonly roles: ITargetRoleRepository,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Roles and criteria the fit score is measured against' })
  async list(): Promise<TargetRoleDto[]> {
    return this.roles.list();
  }

  @Put()
  @ApiOperation({ summary: 'Replace the whole list' })
  async replace(@Body() dto: ReplaceTargetRolesDto): Promise<TargetRoleDto[]> {
    return this.roles.replaceAll(
      dto.roles.map((r) => ({ title: r.title.trim(), criteria: r.criteria?.trim() })),
    );
  }
}
