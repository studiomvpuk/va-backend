import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';
import { Argon2Hasher } from './argon2.hasher';
import { PASSWORD_HASHER } from './password.interface';
import { REFRESH_TOKEN_REPOSITORY } from './token.repository';
import { PrismaRefreshTokenRepository } from './prisma-token.repository';
import { JwtGuard } from './guards/jwt.guard';
import { RolesGuard } from './guards/roles.guard';
import { TenantGuard } from '../../core/tenancy/tenant.guard';
import { AccountsModule } from '../accounts/accounts.module';

@Module({
  imports: [JwtModule.register({}), AccountsModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    TokenService,
    { provide: PASSWORD_HASHER, useClass: Argon2Hasher },
    { provide: REFRESH_TOKEN_REPOSITORY, useClass: PrismaRefreshTokenRepository },

    /*
     * Guards are global and default-deny, in this order:
     *
     *   JwtGuard    verifies the bearer token, or lets @Public() through
     *   RolesGuard  enforces @Roles(); refuses a route that declares none
     *   TenantGuard populates the tenant context from the verified claims
     *
     * Order matters: TenantGuard reads claims JwtGuard produced, and refusing
     * an unauthorised caller before establishing their tenant means a rejected
     * request never gets a scope at all.
     */
    { provide: APP_GUARD, useClass: JwtGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: TenantGuard },
  ],
  exports: [AuthService, TokenService],
})
export class AuthModule {}
