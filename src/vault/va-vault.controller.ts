import { Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { VaultService } from './vault.service';
import { Roles } from '../identity/auth/decorators/roles.decorator';
import { CurrentUser } from '../identity/auth/decorators/current-user.decorator';
import type { AccessTokenClaims } from '../identity/auth/auth.types';
import { RevealStatusDto, RevealedCredentialDto } from './dto/vault.dto';

/**
 * Everything a VA can do with credentials. All three routes, in full.
 *
 * Note what is missing and cannot be added by accident: there is no list of
 * credentials, no bulk reveal, and no route that takes more than one site id.
 * The VA's sites list below returns names and usernames only — enough to know
 * where they are allowed to apply, with no secret in it.
 */
@ApiTags('va')
@Controller('va/sites')
@Roles('VA')
export class VaVaultController {
  constructor(private readonly vault: VaultService) {}

  @Get()
  @ApiOperation({
    summary: 'Sites this assistant may apply through',
    description: 'Names and usernames only. Never a password.',
  })
  async list() {
    const sites = await this.vault.listSites();
    return sites.map((s) => ({
      id: s.id,
      name: s.name,
      url: s.url,
      username: s.username,
      hasPassword: s.hasPassword,
    }));
  }

  @Post(':id/reveal')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Reveal the password for ONE site',
    description:
      'Logged with the site, assistant, time and IP. Hidden again after 60 ' +
      'seconds. Refused until the account owner has released it.',
  })
  async reveal(
    @Param('id') id: string,
    @CurrentUser() user: AccessTokenClaims,
    @Req() req: Request,
  ): Promise<RevealedCredentialDto> {
    return this.vault.revealForVa({ siteId: id, vaId: user.sub, ipAddress: req.ip });
  }

  @Get('reveals/:revealId/status')
  @ApiOperation({
    summary: 'Has this password been rotated since it was shown?',
    description:
      'Polled once mid-countdown, so a rotation during a reveal surfaces ' +
      'immediately rather than as an unexplained login failure.',
  })
  async revealStatus(@Param('revealId') revealId: string): Promise<RevealStatusDto> {
    return { superseded: await this.vault.isRevealStale(revealId) };
  }
}
