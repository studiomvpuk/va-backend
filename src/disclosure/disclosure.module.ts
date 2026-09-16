import { Module } from '@nestjs/common';
import { PrismaSensitiveValueRepository } from './prisma-sensitive-value.repository';
import { DisclosureService } from './disclosure.service';
import {
  SENSITIVE_VALUE_READER,
  SENSITIVE_VALUE_WRITER,
} from './sensitive-value.repository';
import { AiModule } from '../ai/ai.module';

/**
 * One class, two tokens, two very different export policies.
 *
 * The WRITER is exported — ProfileModule needs it to store a value when a field
 * is flagged sensitive. The READER is exported too, but the only consumer is
 * DisclosureService in this module, and the architecture test is what keeps
 * that true.
 */
@Module({
  imports: [AiModule],
  providers: [
    PrismaSensitiveValueRepository,
    { provide: SENSITIVE_VALUE_READER, useExisting: PrismaSensitiveValueRepository },
    { provide: SENSITIVE_VALUE_WRITER, useExisting: PrismaSensitiveValueRepository },
    DisclosureService,
  ],
  exports: [SENSITIVE_VALUE_READER, SENSITIVE_VALUE_WRITER, DisclosureService],
})
export class DisclosureModule {}
