import { Module } from '@nestjs/common';
import { VaultController } from './vault.controller';
import { VaVaultController } from './va-vault.controller';
import { VaultService } from './vault.service';
import { SITE_REPOSITORY } from './site.repository';
import { PrismaSiteRepository } from './prisma-site.repository';
import {
  CREDENTIAL_REVEALER,
  CREDENTIAL_WRITER,
} from './credential.repository';
import { PrismaCredentialRepository } from './prisma-credential.repository';

/**
 * One implementation class behind two tokens with different reach.
 *
 * VaultService is the only consumer of either, and it is what applies the §7.4
 * gate before the revealer is ever called. Controllers inject the service, not
 * the repositories — so there is no path from a route to a raw credential read.
 */
@Module({
  controllers: [VaultController, VaVaultController],
  providers: [
    VaultService,
    { provide: SITE_REPOSITORY, useClass: PrismaSiteRepository },
    PrismaCredentialRepository,
    { provide: CREDENTIAL_REVEALER, useExisting: PrismaCredentialRepository },
    { provide: CREDENTIAL_WRITER, useExisting: PrismaCredentialRepository },
  ],
  exports: [VaultService],
})
export class VaultModule {}
