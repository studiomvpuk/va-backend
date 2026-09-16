import { Module } from '@nestjs/common';
import { VaChatController } from './va-chat.controller';
import { AssessmentService } from './assessment.service';
import { ApplicationsController } from '../applications/applications.controller';
import { APPLICATION_REPOSITORY } from '../applications/application.repository';
import { PrismaApplicationRepository } from '../applications/prisma-application.repository';
import { FitScoringService } from '../assessment/fit/fit-scoring.service';
import { ApplicationPolicyService } from '../assessment/fit/application-policy.service';
import { DraftingService } from '../drafting/drafting.service';
import { AiModule } from '../ai/ai.module';
import { DisclosureModule } from '../disclosure/disclosure.module';
import { ProfileModule } from '../profile/profile.module';
import { TargetingModule } from '../targeting/targeting.module';
import { SettingsModule } from '../settings/settings.module';
import { PROFILE_REPOSITORY } from '../profile/profile.repository';
import { PrismaProfileRepository } from '../profile/prisma-profile.repository';

@Module({
  imports: [AiModule, DisclosureModule, ProfileModule, TargetingModule, SettingsModule],
  controllers: [VaChatController, ApplicationsController],
  providers: [
    AssessmentService,
    FitScoringService,
    ApplicationPolicyService,
    DraftingService,
    { provide: APPLICATION_REPOSITORY, useClass: PrismaApplicationRepository },
    { provide: PROFILE_REPOSITORY, useClass: PrismaProfileRepository },
  ],
  exports: [AssessmentService, APPLICATION_REPOSITORY],
})
export class ConversationModule {}
