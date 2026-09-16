import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { VaController } from './va.controller';
import { VaOnboardingController } from './va-onboarding.controller';
import { VaService } from './va.service';
import { VA_REPOSITORY } from './va.repository';
import { PrismaVaRepository } from './prisma-va.repository';
import { AgreementGuard } from './guards/agreement.guard';
import { AuthModule } from '../auth/auth.module';

/**
 * AgreementGuard is registered globally, after the three guards from Phase 1.
 * Nest runs APP_GUARDs in registration order across modules, and this module is
 * imported after AuthModule, so by the time it runs the token is verified and
 * the role is known — which is what lets it skip Client requests cheaply.
 */
@Module({
  imports: [AuthModule],
  controllers: [VaController, VaOnboardingController],
  providers: [
    VaService,
    { provide: VA_REPOSITORY, useClass: PrismaVaRepository },
    { provide: APP_GUARD, useClass: AgreementGuard },
  ],
  exports: [VaService, VA_REPOSITORY],
})
export class VaModule {}
