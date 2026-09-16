import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppConfigModule } from './core/config/config.module';
import { CryptoModule } from './core/crypto/crypto.module';
import { AuditModule } from './core/audit/audit.module';
import { TenancyModule } from './core/tenancy/tenancy.module';
import { PersistenceModule } from './core/persistence/persistence.module';
import { HealthModule } from './health/health.module';
import { AuthModule } from './identity/auth/auth.module';
import { ProfileModule } from './profile/profile.module';
import { SettingsModule } from './settings/settings.module';
import { VaultModule } from './vault/vault.module';
import { TargetingModule } from './targeting/targeting.module';
import { KeyringModule } from './keyring/keyring.module';
import { AuditLogModule } from './audit-log/audit-log.module';
import { AiModule } from './ai/ai.module';
import { VaModule } from './identity/va/va.module';
import { ConversationModule } from './conversation/conversation.module';
import { RateLimitModule } from './ratelimit/rate-limit.module';
import { NotificationsModule } from './notifications/notifications.module';
import { KnowledgeGapModule } from './knowledge-gap/knowledge-gap.module';
import { ApplicationsModule } from './applications/applications.module';
import { PrepModule } from './prep/prep.module';
import { JobsModule } from './core/jobs/jobs.module';

@Module({
  imports: [
    // Order matters only for readability — all of these are @Global.
    AppConfigModule,
    PersistenceModule,
    TenancyModule,
    CryptoModule,
    AuditModule,
    JobsModule,

    // Baseline throttling. Per-Client and per-VA limits arrive in Phase 4.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),

    AuthModule,
    VaModule,
    ConversationModule,
    ProfileModule,
    SettingsModule,
    VaultModule,
    TargetingModule,
    KeyringModule,
    AuditLogModule,
    RateLimitModule,
    NotificationsModule,
    KnowledgeGapModule,
    ApplicationsModule,
    PrepModule,
    AiModule,
    HealthModule,
  ],
})
export class AppModule {}
