import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import { TokenService } from './token.service';
import type { AppConfigService } from '../../core/config/app-config.service';
import type {
  IRefreshTokenRepository,
  NewRefreshToken,
  StoredRefreshToken,
} from './token.repository';
import type { AccessTokenClaims } from './auth.types';

/** In-memory double. Domain logic is tested without a database, by design. */
class FakeTokenRepo implements IRefreshTokenRepository {
  rows: StoredRefreshToken[] = [];
  private seq = 0;

  async create(t: NewRefreshToken): Promise<StoredRefreshToken> {
    const row: StoredRefreshToken = {
      id: `t${++this.seq}`,
      tokenHash: t.tokenHash,
      familyId: t.familyId,
      subjectType: t.subjectType,
      subjectId: t.subjectId,
      expiresAt: t.expiresAt,
      usedAt: null,
      revokedAt: null,
    };
    this.rows.push(row);
    return row;
  }
  async findByHash(h: string) {
    return this.rows.find((r) => r.tokenHash === h) ?? null;
  }
  async markUsed(id: string) {
    const r = this.rows.find((x) => x.id === id);
    if (r) r.usedAt = new Date();
  }
  async revokeFamily(familyId: string) {
    const hit = this.rows.filter((r) => r.familyId === familyId && !r.revokedAt);
    hit.forEach((r) => (r.revokedAt = new Date()));
    return hit.length;
  }
  async revokeAllForSubject(st: string, sid: string) {
    const hit = this.rows.filter(
      (r) => r.subjectType === st && r.subjectId === sid && !r.revokedAt,
    );
    hit.forEach((r) => (r.revokedAt = new Date()));
    return hit.length;
  }
  async deleteExpired(now: Date) {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.expiresAt >= now);
    return before - this.rows.length;
  }
}

const config = {
  get: (k: string) =>
    ({
      JWT_SECRET: 'a'.repeat(40),
      ACCESS_TOKEN_TTL_SECONDS: 900,
      REFRESH_TOKEN_TTL_DAYS: 7,
    })[k],
} as unknown as AppConfigService;

const CLAIMS: AccessTokenClaims = {
  sub: 'client_1',
  role: 'CLIENT',
  clientId: 'client_1',
  email: 'a@b.c',
};

describe('TokenService', () => {
  let repo: FakeTokenRepo;
  let service: TokenService;
  const resolve = async () => CLAIMS;

  beforeEach(() => {
    repo = new FakeTokenRepo();
    service = new TokenService(new JwtService(), config, repo);
  });

  it('issues a verifiable access token carrying the tenant claim', async () => {
    const { accessToken } = await service.issuePair(CLAIMS, 'CLIENT');
    const verified = await service.verifyAccessToken(accessToken);
    expect(verified.clientId).toBe('client_1');
    expect(verified.role).toBe('CLIENT');
  });

  it('never stores the refresh token itself', async () => {
    const { refreshToken } = await service.issuePair(CLAIMS, 'CLIENT');
    expect(repo.rows).toHaveLength(1);
    expect(repo.rows[0].tokenHash).not.toBe(refreshToken);
    expect(repo.rows[0].tokenHash).toBe(TokenService.hash(refreshToken));
  });

  it('rotates: the old token stops working and a new one is issued', async () => {
    const first = await service.issuePair(CLAIMS, 'CLIENT');
    const second = await service.rotate(first.refreshToken, resolve);

    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(repo.rows[0].usedAt).not.toBeNull();
  });

  it('keeps the rotated token in the same family', async () => {
    const first = await service.issuePair(CLAIMS, 'CLIENT');
    await service.rotate(first.refreshToken, resolve);
    expect(repo.rows[1].familyId).toBe(repo.rows[0].familyId);
  });

  /**
   * The acceptance criterion from the PRD: replay returns 401.
   */
  it('REPLAY: presenting a used token is rejected', async () => {
    const first = await service.issuePair(CLAIMS, 'CLIENT');
    await service.rotate(first.refreshToken, resolve);

    await expect(service.rotate(first.refreshToken, resolve)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('REPLAY: revokes the entire family, so the thief AND the victim are logged out', async () => {
    const first = await service.issuePair(CLAIMS, 'CLIENT');
    const second = await service.rotate(first.refreshToken, resolve);
    const third = await service.rotate(second.refreshToken, resolve);

    // An attacker replays the stolen first token.
    await expect(service.rotate(first.refreshToken, resolve)).rejects.toThrow();

    // The legitimate current token is now dead too. That is intended: one
    // re-login is the correct price for a possible theft.
    await expect(service.rotate(third.refreshToken, resolve)).rejects.toThrow();
    expect(repo.rows.every((r) => r.revokedAt !== null)).toBe(true);
  });

  it('rejects an unknown token', async () => {
    await expect(service.rotate('not-a-real-token', resolve)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects an expired token', async () => {
    const { refreshToken } = await service.issuePair(CLAIMS, 'CLIENT');
    repo.rows[0].expiresAt = new Date(Date.now() - 1000);
    await expect(service.rotate(refreshToken, resolve)).rejects.toThrow(/expired/i);
  });

  it('rejects a revoked token', async () => {
    const { refreshToken } = await service.issuePair(CLAIMS, 'CLIENT');
    await repo.revokeFamily(repo.rows[0].familyId);
    await expect(service.rotate(refreshToken, resolve)).rejects.toThrow();
  });

  it('rebuilds claims on every refresh, so a revoked account loses access', async () => {
    const { refreshToken } = await service.issuePair(CLAIMS, 'VA');
    // The account has since been revoked — resolveClaims returns null.
    await expect(service.rotate(refreshToken, async () => null)).rejects.toThrow(
      /no longer active/i,
    );
    // And its family is burned, so the remaining tokens are dead too.
    expect(repo.rows.every((r) => r.revokedAt !== null)).toBe(true);
  });

  it('logging out revokes the whole family, not just the presented token', async () => {
    const first = await service.issuePair(CLAIMS, 'CLIENT');
    const second = await service.rotate(first.refreshToken, resolve);
    await service.revokeSession(second.refreshToken);
    expect(repo.rows.every((r) => r.revokedAt !== null)).toBe(true);
  });

  it('logging out with an unknown token is a no-op, not an error', async () => {
    await expect(service.revokeSession('garbage')).resolves.toBeUndefined();
  });

  it('logout-everywhere revokes across separate logins', async () => {
    await service.issuePair(CLAIMS, 'CLIENT');
    await service.issuePair(CLAIMS, 'CLIENT'); // a second device
    expect(new Set(repo.rows.map((r) => r.familyId)).size).toBe(2);

    const revoked = await service.revokeAllSessions('CLIENT', 'client_1');
    expect(revoked).toBe(2);
  });

  it('rejects a tampered access token', async () => {
    const { accessToken } = await service.issuePair(CLAIMS, 'CLIENT');
    const [h, p, s] = accessToken.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...CLAIMS, clientId: 'client_2' }),
    ).toString('base64url');
    await expect(service.verifyAccessToken(`${h}.${forged}.${s}`)).rejects.toThrow();
    expect(p).toBeTruthy();
  });
});
