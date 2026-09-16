import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Put,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../identity/auth/decorators/roles.decorator';
import { AUDIT_LOGGER, type IAuditLogger } from '../core/audit/audit.interface';
import {
  CREDENTIAL_CIPHER,
  type ICredentialCipher,
} from '../core/crypto/cipher.interface';
import {
  PROVIDER_KEY_REPOSITORY,
  type IProviderKeyRepository,
  type Provider,
} from './provider-key.repository';
import { ProviderKeyStatusDto, SetProviderKeyDto } from './dto/keyring.dto';

const PROVIDERS = new Set(['ANTHROPIC', 'OPENAI']);

/**
 * BYOK keys. Two write routes and a status route — no read route exists.
 *
 * `GET` returns whether a key is set and its last four characters. That is
 * enough for a Client to confirm they stored the right one, and not enough for
 * anyone to use it. The PRD's acceptance criterion is exactly this: "GET on any
 * settings route returns null or a masked stub for stored API keys, never
 * ciphertext and never plaintext."
 */
@ApiTags('settings')
@Controller('settings/keys')
@Roles('CLIENT')
export class KeyringController {
  constructor(
    @Inject(PROVIDER_KEY_REPOSITORY) private readonly keys: IProviderKeyRepository,
    @Inject(CREDENTIAL_CIPHER) private readonly cipher: ICredentialCipher,
    @Inject(AUDIT_LOGGER) private readonly audit: IAuditLogger,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Which provider keys are configured' })
  async status(): Promise<ProviderKeyStatusDto[]> {
    return this.keys.status();
  }

  @Put(':provider')
  @HttpCode(204)
  @ApiOperation({ summary: 'Store or replace a provider key' })
  async put(
    @Param('provider') provider: string,
    @Body() dto: SetProviderKeyDto,
  ): Promise<void> {
    const normalised = this.normalise(provider);
    const key = dto.key.trim();

    await this.keys.put(normalised, await this.cipher.encrypt(key), key.slice(-4));
    // Records that a key was set — never any part of it beyond the hint the
    // Client already sees.
    await this.audit.record({
      action: 'byok_key.set',
      subjectType: 'ProviderKey',
      subjectId: normalised,
      metadata: { provider: normalised },
    });
  }

  @Delete(':provider')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a stored provider key' })
  async remove(@Param('provider') provider: string): Promise<void> {
    await this.keys.remove(this.normalise(provider));
  }

  private normalise(provider: string): Provider {
    const upper = provider.toUpperCase();
    if (!PROVIDERS.has(upper)) throw new BadRequestException('Unknown provider');
    return upper as Provider;
  }
}
