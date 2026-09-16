import { Module } from '@nestjs/common';
import { SettingsController } from './settings.controller';
import { SETTINGS_REPOSITORY } from './settings.repository';
import { PrismaSettingsRepository } from './prisma-settings.repository';

@Module({
  controllers: [SettingsController],
  providers: [{ provide: SETTINGS_REPOSITORY, useClass: PrismaSettingsRepository }],
  exports: [SETTINGS_REPOSITORY],
})
export class SettingsModule {}
