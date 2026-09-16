import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';
import type { IPasswordHasher } from './password.interface';
import type {
  ClientRecord,
  IAccountRepository,
  VaRecord,
} from '../accounts/client.repository';
import type { AppConfigService } from '../../core/config/app-config.service';
import type {
  IRefreshTokenRepository,
  NewRefreshToken,
  StoredRefreshToken,
} from './token.repository';

/**
 * Fast, deterministic stand-in — argon2 costs 50ms per call by design.
 *
 * Uses a real digest rather than `hashed:${p}`, so a test asserting the stored
 * value does not contain the password is testing AuthService rather than the
 * fake's formatting.
 */
class FakeHasher implements IPasswordHasher {
  weak = new Set<string>();
  private digest(p: string) {
    return createHash('sha256').update(`fake-kdf:${p}`).digest('hex');
  }
  async hash(p: string) {
    return this.digest(p);
  }
  async verify(h: string, p: string) {
    return h === this.digest(p);
  }
  needsRehash(h: string) {
    return this.weak.has(h);
  }
}

class FakeAccounts implements IAccountRepository {
  clients: ClientRecord[] = [];
  vas: VaRecord[] = [];
  private seq = 0;

  async findClientByEmail(email: string) {
    return this.clients.find((c) => c.email === email) ?? null;
  }
  async findClientById(id: string) {
    return this.clients.find((c) => c.id === id) ?? null;
  }
  async createClient(i: { email: string; fullName: string; passwordHash: string }) {
    const c = { id: `client_${++this.seq}`, ...i };
    this.clients.push(c);
    return c;
  }
  async updateClientPasswordHash(id: string, passwordHash: string) {
    const c = this.clients.find((x) => x.id === id);
    if (c) c.passwordHash = passwordHash;
  }
  async findVaById(id: string) {
    return this.vas.find((v) => v.id === id) ?? null;
  }
  async findVaByEmail(email: string) {
    return this.vas.find((v) => v.email === email) ?? null;
  }
}

class FakeTokenRepo implements IRefreshTokenRepository {
  rows: StoredRefreshToken[] = [];
  private seq = 0;
  async create(t: NewRefreshToken) {
    const r = { id: `t${++this.seq}`, ...t, usedAt: null, revokedAt: null } as StoredRefreshToken;
    this.rows.push(r);
    return r;
  }
  async findByHash(h: string) {
    return this.rows.find((r) => r.tokenHash === h) ?? null;
  }
  async markUsed(id: string) {
    const r = this.rows.find((x) => x.id === id);
    if (r) r.usedAt = new Date();
  }
  async revokeFamily(f: string) {
    const hit = this.rows.filter((r) => r.familyId === f && !r.revokedAt);
    hit.forEach((r) => (r.revokedAt = new Date()));
    return hit.length;
  }
  async revokeAllForSubject() {
    return 0;
  }
  async deleteExpired() {
    return 0;
  }
}

const config = {
  get: (k: string) =>
    ({ JWT_SECRET: 'a'.repeat(40), ACCESS_TOKEN_TTL_SECONDS: 900, REFRESH_TOKEN_TTL_DAYS: 7 })[k],
} as unknown as AppConfigService;

describe('AuthService', () => {
  let accounts: FakeAccounts;
  let hasher: FakeHasher;
  let tokens: TokenService;
  let auth: AuthService;

  beforeEach(() => {
    accounts = new FakeAccounts();
    hasher = new FakeHasher();
    tokens = new TokenService(new JwtService(), config, new FakeTokenRepo());
    auth = new AuthService(tokens, hasher, accounts);
  });

  const register = () =>
    auth.registerClient({
      email: 'Olont@Example.com',
      fullName: '  Tolulope Olonibua  ',
      password: 'correct-horse-battery',
    });

  describe('registration', () => {
    it('creates a client and returns a usable token pair', async () => {
      const result = await register();
      expect(result.user.role).toBe('CLIENT');
      const claims = await tokens.verifyAccessToken(result.accessToken);
      expect(claims.clientId).toBe(result.user.id);
    });

    it('normalises email case and trims the name', async () => {
      const result = await register();
      expect(result.user.email).toBe('olont@example.com');
      expect(result.user.fullName).toBe('Tolulope Olonibua');
    });

    it('rejects a duplicate email', async () => {
      await register();
      await expect(register()).rejects.toBeInstanceOf(ConflictException);
    });

    it('stores a hash, never the password', async () => {
      await register();
      expect(accounts.clients[0].passwordHash).not.toContain('correct-horse');
    });
  });

  describe('login', () => {
    it('accepts the right password, case-insensitively on email', async () => {
      await register();
      const result = await auth.loginClient({
        email: 'OLONT@example.com',
        password: 'correct-horse-battery',
      });
      expect(result.user.id).toBe(accounts.clients[0].id);
    });

    it('rejects a wrong password', async () => {
      await register();
      await expect(
        auth.loginClient({ email: 'olont@example.com', password: 'wrong' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    /**
     * Account enumeration: an unknown email and a wrong password must be
     * indistinguishable to the caller.
     */
    it('gives an identical error for an unknown email and a wrong password', async () => {
      await register();
      const unknown = await auth
        .loginClient({ email: 'nobody@example.com', password: 'x' })
        .catch((e: Error) => e.message);
      const wrong = await auth
        .loginClient({ email: 'olont@example.com', password: 'x' })
        .catch((e: Error) => e.message);
      expect(unknown).toBe(wrong);
    });

    it('still verifies a hash when no account exists, so timing does not leak', async () => {
      const spy = jest.spyOn(hasher, 'verify');
      await auth.loginClient({ email: 'nobody@example.com', password: 'x' }).catch(() => {});
      expect(spy).toHaveBeenCalled();
    });

    it('upgrades a stale hash on successful login', async () => {
      await register();
      hasher.weak.add(accounts.clients[0].passwordHash);
      const upgrade = jest.spyOn(accounts, 'updateClientPasswordHash');

      await auth.loginClient({
        email: 'olont@example.com',
        password: 'correct-horse-battery',
      });
      expect(upgrade).toHaveBeenCalledWith(accounts.clients[0].id, expect.any(String));
    });

    it('does not rehash when the stored hash is current', async () => {
      await register();
      const upgrade = jest.spyOn(accounts, 'updateClientPasswordHash');
      await auth.loginClient({
        email: 'olont@example.com',
        password: 'correct-horse-battery',
      });
      expect(upgrade).not.toHaveBeenCalled();
    });
  });

  describe('VA login', () => {
    beforeEach(() => {
      accounts.vas.push({
        id: 'va_1',
        clientId: 'client_owner',
        email: 'joy@example.com',
        fullName: 'Joy Emoredo',
        passwordHash: createHash('sha256').update('fake-kdf:va-password-here').digest('hex'),
        revokedAt: null,
      });
    });

    it("carries the inviting Client's id as the tenant claim", async () => {
      const result = await auth.loginVa({
        email: 'joy@example.com',
        password: 'va-password-here',
      });
      const claims = await tokens.verifyAccessToken(result.accessToken);
      expect(claims.role).toBe('VA');
      expect(claims.sub).toBe('va_1');
      // This is the line that confines a VA to exactly one Client's data.
      expect(claims.clientId).toBe('client_owner');
    });

    it('rejects a revoked VA with the same message as a wrong password', async () => {
      accounts.vas[0].revokedAt = new Date();
      const revoked = await auth
        .loginVa({ email: 'joy@example.com', password: 'va-password-here' })
        .catch((e: Error) => e.message);
      const wrong = await auth
        .loginVa({ email: 'joy@example.com', password: 'nope' })
        .catch((e: Error) => e.message);
      expect(revoked).toBe(wrong);
    });

    it('rejects a VA who has not set a password yet', async () => {
      accounts.vas[0].passwordHash = null;
      await expect(
        auth.loginVa({ email: 'joy@example.com', password: 'anything' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('refresh', () => {
    it('returns a new pair and the current user', async () => {
      const first = await register();
      const second = await auth.refresh(first.refreshToken);
      expect(second.user.id).toBe(first.user.id);
      expect(second.refreshToken).not.toBe(first.refreshToken);
    });

    it('reflects a VA revoked since login, rather than waiting for expiry', async () => {
      accounts.vas.push({
        id: 'va_1',
        clientId: 'c1',
        email: 'j@e.com',
        fullName: 'J',
        passwordHash: createHash('sha256').update('fake-kdf:pw-long-enough').digest('hex'),
        revokedAt: null,
      });
      const login = await auth.loginVa({ email: 'j@e.com', password: 'pw-long-enough' });

      accounts.vas[0].revokedAt = new Date();
      await expect(auth.refresh(login.refreshToken)).rejects.toThrow();
    });
  });
});
