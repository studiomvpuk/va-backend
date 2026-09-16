import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { SettingsModule } from '../settings/settings.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { KnowledgeGapController } from './knowledge-gap.controller';
import { KnowledgeGapService } from './knowledge-gap.service';
import { GapDetector } from './gap-detector';
import { QaBankService } from './qa-bank/qa-bank.service';
import { KNOWLEDGE_GAP_REPOSITORY } from './knowledge-gap.repository';
import { PrismaKnowledgeGapRepository } from './prisma-knowledge-gap.repository';
import { QA_BANK_REPOSITORY } from './qa-bank/qa-bank.repository';
import { PrismaQaBankRepository } from './qa-bank/prisma-qa-bank.repository';

@Module({
  imports: [AiModule, SettingsModule, NotificationsModule],
  controllers: [KnowledgeGapController],
  providers: [
    KnowledgeGapService,
    QaBankService,
    GapDetector,
    { provide: KNOWLEDGE_GAP_REPOSITORY, useClass: PrismaKnowledgeGapRepository },
    { provide: QA_BANK_REPOSITORY, useClass: PrismaQaBankRepository },
  ],
  exports: [KnowledgeGapService, QaBankService],
})
export class KnowledgeGapModule {}
