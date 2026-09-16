import { forwardRef, Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { ApplicationsModule } from '../applications/applications.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ProfileModule } from '../profile/profile.module';
import { PrepController } from './prep.controller';
import { PrepService } from './prep.service';
import { PrepComposer } from './prep-composer';
import { PrepGenerationHandler } from './prep-generation.handler';
import { PREP_REPOSITORY } from './prep.repository';
import { PrismaPrepRepository } from './prisma-prep.repository';

@Module({
  imports: [
    AiModule,
    forwardRef(() => ApplicationsModule),
    NotificationsModule,
    ProfileModule,
  ],
  controllers: [PrepController],
  providers: [
    PrepService,
    PrepComposer,
    PrepGenerationHandler,
    { provide: PREP_REPOSITORY, useClass: PrismaPrepRepository },
  ],
  exports: [PrepService],
})
export class PrepModule {}
