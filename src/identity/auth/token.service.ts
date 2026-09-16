import { Inject, Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AppConfigService } from '../../core/config/app-config.service';
import {
  REFRESH_TOKEN_REPOSITORY,
  type IRefreshTokenRepository,
} from './token.repository';
import type { SubjectType } from './refresh-token.model';
import type { AccessTokenClaims, RequestMeta, TokenPair } from './auth.types';

/**
 * Rotating refresh tokens with reuse detection.
 *
 * Every refresh issues a new token and marks the old one used. Presenting a
 * token that has already been used means one of two things: a race, or a stolen
 * token being replayed. Both are handled the same way — revoke the entire
 * family descended from that login, forcing a fresh sign-in. Treating a race as
 * theft costs one re-login; treating theft as a race costs the account.
 *
 * Tokens are stored as sha256 hashes. A database dump therefore does not hand
 * over live sessions. sha256 rather than argon2 is correct here: the token is
 * 256 bits of CSPRNG output, so there is nothing to brute-force, and refresh is
 * on a hot path.
 */
@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
    @Inject(REFRESH_TOKEN_REPOSITORY)
    private readonly tokens: IRefreshTokenRepository,
  ) {}

  async issuePair(
    claims: AccessTokenClaims,
    subjectType: SubjectType,
    meta: RequestMeta = {},
    familyId: string = randomUUID(),
  ): Promise<TokenPair> {
    const accessToken = await this.jwt.signAsync(claims, {
      secret: this.config.get('JWT_SECRET'),
      expiresIn: this.config.get('ACCESS_TOKEN_TTL_SECONDS'),
    });

    const refreshToken = randomBytes(32).toString('base64url');
    const refreshExpiresAt = new Date(
      Date.now() + this.config.get('REFRESH_TOKEN_TTL_DAYS') * 86_400_000,
    );

    await this.tokens.create({
      tokenHash: TokenService.hash(refreshToken),
      familyId,
      subjectType,
      subjectId: claims.sub,
      expiresAt: refreshExpiresAt,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return { accessToken, refreshToken, refreshExpiresAt };
  }

  /**
   * Exchanges a refresh token for a new pair.
   *
   * @param resolveClaims Called only after the token is proven valid, to build
   *   fresh claims from current state — so a VA revoked since login, or a
   *   changed email, is reflected on the next refresh rather than persisting
   *   for the life of the token.
   */
  async rotate(
    presentedToken: string,
    resolveClaims: (
      subjectType: SubjectType,
      subjectId: string,
    ) => Promise<AccessTokenClaims | null>,
    meta: RequestMeta = {},
  ): Promise<TokenPair> {
    const stored = await this.tokens.findByHash(TokenService.hash(presentedToken));

    if (!stored) throw new UnauthorizedException('Invalid refresh token');

    if (stored.usedAt) {
      // Replay. Assume theft and burn the family.
      const revoked = await this.tokens.revokeFamily(stored.familyId);
      this.logger.warn(
        `Refresh token reuse detected for ${stored.subjectType} ${stored.subjectId}; ` +
          `revoked ${revoked} token(s) in family ${stored.familyId}`,
      );
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (stored.revokedAt) throw new UnauthorizedException('Invalid refresh token');
    if (stored.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Refresh token expired');
    }

    const claims = await resolveClaims(stored.subjectType, stored.subjectId);
    if (!claims) {
      // The account is gone or revoked. Burn the family so the remaining
      // tokens cannot be used either.
      await this.tokens.revokeFamily(stored.familyId);
      throw new UnauthorizedException('Account is no longer active');
    }

    await this.tokens.markUsed(stored.id);

    // Same family — the chain from one login stays linked, so reuse anywhere in
    // it revokes the whole chain.
    return this.issuePair(claims, stored.subjectType, meta, stored.familyId);
  }

  async revokeSession(presentedToken: string): Promise<void> {
    const stored = await this.tokens.findByHash(TokenService.hash(presentedToken));
    // Logging out with an unknown token is not an error worth reporting — the
    // caller wanted to be logged out, and they are.
    if (stored) await this.tokens.revokeFamily(stored.familyId);
  }

  async revokeAllSessions(subjectType: SubjectType, subjectId: string): Promise<number> {
    return this.tokens.revokeAllForSubject(subjectType, subjectId);
  }

  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    try {
      return await this.jwt.verifyAsync<AccessTokenClaims>(token, {
        secret: this.config.get('JWT_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }

  static hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
