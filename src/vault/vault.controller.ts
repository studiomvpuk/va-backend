import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { VaultService } from './vault.service';
import { Roles } from '../identity/auth/decorators/roles.decorator';
import {
  AcknowledgeSharingDto,
  CreateSiteDto,
  SetPasswordDto,
  SiteDto,
  UpdateSiteDto,
} from './dto/vault.dto';

/**
 * Client-side vault management. Every route is CLIENT-only.
 *
 * No route here returns a password. The Client sets and rotates; they never
 * read back. That is not an oversight — a Client who needs to know the password
 * has it in their own password manager, and adding a read path would mean a
 * second place the plaintext can escape.
 */
@ApiTags('vault')
@Controller('sites')
@Roles('CLIENT')
export class VaultController {
  constructor(private readonly vault: VaultService) {}

  @Get()
  @ApiOperation({ summary: 'Approved sites and their vault state' })
  async list(): Promise<SiteDto[]> {
    return this.vault.listSites();
  }

  @Post()
  @ApiOperation({ summary: 'Add a site the VA may apply through' })
  async create(@Body() dto: CreateSiteDto): Promise<SiteDto> {
    return this.vault.createSite(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a site' })
  async update(@Param('id') id: string, @Body() dto: UpdateSiteDto): Promise<SiteDto> {
    return this.vault.updateSite(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a site and any stored password' })
  async remove(@Param('id') id: string): Promise<void> {
    await this.vault.deleteSite(id);
  }

  @Put(':id/credential')
  @ApiOperation({
    summary: 'Set or rotate the stored password',
    description:
      'One endpoint for both. Rotating is the obvious action here by design — ' +
      'it is what releases the credential to a newly onboarded assistant.',
  })
  async setPassword(
    @Param('id') id: string,
    @Body() dto: SetPasswordDto,
  ): Promise<SiteDto> {
    return this.vault.setPassword(id, dto.password, { rotate: dto.rotate ?? false });
  }

  @Delete(':id/credential')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove the stored password, keeping the site' })
  async removePassword(@Param('id') id: string): Promise<void> {
    await this.vault.removePassword(id);
  }

  @Get(':id/sharing-status')
  @ApiOperation({
    summary: 'Whether this password is released to a given assistant',
    description: 'Drives the rotate-or-confirm prompt before onboarding.',
  })
  async sharingStatus(@Param('id') id: string, @Query('vaId') vaId: string) {
    return this.vault.gateStatusFor(id, vaId);
  }

  @Post(':id/acknowledge-sharing')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Confirm sharing the current password without rotating',
    description: 'Recorded in the audit log as an explicit decision.',
  })
  async acknowledge(
    @Param('id') id: string,
    @Body() dto: AcknowledgeSharingDto,
  ): Promise<void> {
    await this.vault.acknowledgeUnrotatedSharing(id, dto.vaId);
  }
}
