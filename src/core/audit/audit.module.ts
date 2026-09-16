import { Global, Module } from '@nestjs/common';
import { AUDIT_LOGGER } from './audit.interface';
import { AuditService } from './audit.service';

@Global()
@Module({
  providers: [{ provide: AUDIT_LOGGER, useClass: AuditService }],
  exports: [AUDIT_LOGGER],
})
export class AuditModule {}
