import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ProfileService } from './profile.service';
import { CvImportService } from './cv-import.service';
import { Roles } from '../identity/auth/decorators/roles.decorator';
import { CurrentUser } from '../identity/auth/decorators/current-user.decorator';
import type { AccessTokenClaims } from '../identity/auth/auth.types';
import {
  CreateFieldDto,
  CvSuggestionsDto,
  ImportCvDto,
  ProfileDto,
  ProfileFieldDto,
  RevealedValueDto,
  UpdateFieldDto,
  UpdateNarrativeDto,
} from './dto/profile.dto';

/**
 * Client-only, every route.
 *
 * There is deliberately no VA-facing profile route anywhere in the codebase.
 * A VA never reads the profile document; they ask a question and the AI answers
 * from it (Phase 6). That is a property of the route table, not of a filter.
 */
@ApiTags('profile')
@Controller('profile')
@Roles('CLIENT')
export class ProfileController {
  constructor(
    private readonly profile: ProfileService,
    private readonly cvImport: CvImportService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'The Client’s profile',
    description:
      'Sensitive field values are never included — only whether one is set.',
  })
  async get(): Promise<ProfileDto> {
    return this.profile.getProfile();
  }

  @Patch('narrative')
  @ApiOperation({ summary: 'Replace the free-form experience narrative' })
  async setNarrative(@Body() dto: UpdateNarrativeDto) {
    return this.profile.setNarrative(dto.body);
  }

  @Post('fields')
  @ApiOperation({ summary: 'Add a profile field' })
  async createField(@Body() dto: CreateFieldDto): Promise<ProfileFieldDto> {
    return this.profile.createField(dto);
  }

  @Patch('fields/:id')
  @ApiOperation({
    summary: 'Update a field’s label, value or visibility',
    description:
      'Changing visibility moves the value between plaintext and encrypted ' +
      'storage in a single transaction.',
  })
  async updateField(
    @Param('id') id: string,
    @Body() dto: UpdateFieldDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<ProfileFieldDto> {
    return this.profile.updateField(id, dto, {
      actorType: user.role,
      actorId: user.sub,
    });
  }

  @Post('fields/:id/reveal')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Show one sensitive value to its owner',
    description: 'Logged as a disclosure, like every other read of protected data.',
  })
  async reveal(
    @Param('id') id: string,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<RevealedValueDto> {
    return {
      value: await this.profile.revealField(id, {
        actorType: user.role,
        actorId: user.sub,
      }),
    };
  }

  @Post('import-cv')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Suggest profile fields from CV text',
    description:
      'Saves nothing. Returns suggestions for you to accept or discard, because ' +
      'a model reading a CV gets things subtly wrong and you are the one who ' +
      'will notice.',
  })
  async importCv(@Body() dto: ImportCvDto): Promise<CvSuggestionsDto> {
    return this.cvImport.suggestFrom(dto.text);
  }

  @Delete('fields/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a field and any stored value' })
  async deleteField(@Param('id') id: string): Promise<void> {
    await this.profile.deleteField(id);
  }
}
