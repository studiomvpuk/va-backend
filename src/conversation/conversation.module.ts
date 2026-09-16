import { Module } from '@nestjs/common';
import { VaChatController } from './va-chat.controller';
import { AssessmentService } from './assessment.service';
import { ApplicationsModule } from '../applications/applications.module';
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
  imports: [
    AiModule,
    /*
     * ApplicationsModule owns ApplicationsController and the repository
     * binding. This module used to declare both itself, which meant the
     * controller was instantiated by two modules with two different dependency
     * graphs — and the copy here could not see PrepService, so the application
     * would not start. Importing is the fix; re-declaring never was.
     */
    ApplicationsModule,
    DisclosureModule,
    ProfileModule,
    TargetingModule,
    SettingsModule,
  ],
  controllers: [VaChatController],
  providers: [
    AssessmentService,
    FitScoringService,
    ApplicationPolicyService,
    DraftingService,
    { provide: PROFILE_REPOSITORY, useClass: PrismaProfileRepository },
  ],
  /*
   * The module, not the token. Nest only re-exports a provider a module owns;
   * APPLICATION_REPOSITORY now belongs to ApplicationsModule, so exporting the
   * module is what passes it on to anyone importing this one.
   */
  exports: [AssessmentService, ApplicationsModule],
})
export class ConversationModule {}
