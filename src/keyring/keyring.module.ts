import { Module } from '@nestjs/common';
import { KeyringController } from './keyring.controller';
import { KeyringService } from './keyring.service';
import { PROVIDER_KEY_REPOSITORY } from './provider-key.repository';
import { PrismaProviderKeyRepository } from './prisma-provider-key.repository';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [SettingsModule],
  controllers: [KeyringController],
  providers: [
    { provide: PROVIDER_KEY_REPOSITORY, useClass: PrismaProviderKeyRepository },
    KeyringService,
  ],
  exports: [PROVIDER_KEY_REPOSITORY, KeyringService],
})
export class KeyringModule {}
