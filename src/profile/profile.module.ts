import { Module } from '@nestjs/common';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';
import { CvImportService } from './cv-import.service';
import { PROFILE_REPOSITORY } from './profile.repository';
import { PrismaProfileRepository } from './prisma-profile.repository';
import { DisclosureModule } from '../disclosure/disclosure.module';
import { AiModule } from '../ai/ai.module';

@Module({
  imports: [DisclosureModule, AiModule],
  controllers: [ProfileController],
  providers: [
    ProfileService,
    CvImportService,
    { provide: PROFILE_REPOSITORY, useClass: PrismaProfileRepository },
  ],
  exports: [ProfileService],
})
export class ProfileModule {}
