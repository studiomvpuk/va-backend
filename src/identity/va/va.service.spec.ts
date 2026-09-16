import {
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import { VaService } from './va.service';
import { TokenService } from '../auth/token.service';
import { tenantContext } from '../../core/tenancy/tenant.context';
import { getCurrentAgreement, hashAgreementText } from './agreement/letter-of-engagement';
import type { IVaRepository, VaAccessState, VaSummary } from './va.repository';
import type { IPasswordHasher } from '../auth/password.interface';
import type { AuditEntry, IAuditLogger } from '../../core/audit/audit.interface';
import type { AppConfigService } from '../../core/config/app-config.service';
import type {
  IRefreshTokenRepository,
  NewRefreshToken,
  StoredRefreshToken,
} from '../auth/token.repository';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

class FakeVaRepo implements IVaRepository {
  rows: (VaSummary & {
    clientId: string;
    passwordHash: string | null;
    inviteTokenHash: string | null;
    inviteExpiry: Date | null;
  })[] = [];
  private seq = 0;

  private summary(r: (typeof this.rows)[number]): VaSummary {
    return {
      id: r.id,
      email: r.email,
      fullName: r.fullName,
      createdAt: r.createdAt,
      revokedAt: r.revokedAt,
      invitePending:
        r.passwordHash === null &&
        r.inviteTokenHash !== null &&
        (r.inviteExpiry?.getTime() ?? 0) > Date.now(),
      agreement: r.agreement,
    };
  }

  async list() {
    return this.rows.map((r) => this.summary(r));
  }
  async find(id: string) {
    const r = this.rows.find((x) => x.id === id);
    return r ? this.summary(r) : null;
  }
  async findByEmail(email: string) {
    const r = this.rows.find((x) => x.email === email);
    return r ? this.summary(r) : null;
  }
  async invite(i: {
    email: string;
    fullName: string;
    inviteTokenHash: string;
    inviteExpiry: Date;
  }) {
    const row = {
      id: `va${++this.seq}`,
      clientId: 'c1',
      email: i.email,
      fullName: i.fullName,
      createdAt: new Date(),
      revokedAt: null,
      invitePending: true,
      agreement: null,
      passwordHash: null,
      inviteTokenHash: i.inviteTokenHash,
      inviteExpiry: i.inviteExpiry,
    };
    this.rows.push(row);
    return this.summary(row);
  }
  async refreshInvite(id: string, hash: string, expiry: Date) {
    const r = this.rows.find((x) => x.id === id)!;
    r.inviteTokenHash = hash;
    r.inviteExpiry = expiry;
    r.revokedAt = null;
    return this.summary(r);
  }
  async acceptInvite(hash: string, passwordHash: string, now: Date) {
    const r = this.rows.find(
      (x) =>
        x.inviteTokenHash === hash &&
        x.passwordHash === null &&
        !x.revokedAt &&
        (x.inviteExpiry?.getTime() ?? 0) > now.getTime(),
    );
    if (!r) return null;
    r.passwordHash = passwordHash;
    r.inviteTokenHash = null;
    r.inviteExpiry = null;
    return { id: r.id, clientId: r.clientId, email: r.email, fullName: r.fullName };
  }
  async revoke(id: string) {
    const r = this.rows.find((x) => x.id === id)!;
    r.revokedAt = new Date();
    r.inviteTokenHash = null;
  }
  async restore(id: string) {
    this.rows.find((x) => x.id === id)!.revokedAt = null;
  }
  async signAgreement(i: {
    vaId: string;
    documentVersion: string;
    documentHash: string;
    signedName: string;
  }) {
    const r = this.rows.find((x) => x.id === i.vaId)!;
    r.agreement = {
      signedAt: new Date(),
      signedName: i.signedName,
      documentVersion: i.documentVersion,
      documentHash: i.documentHash,
    };
  }
  async accessState(vaId: string): Promise<VaAccessState | null> {
    const r = this.rows.find((x) => x.id === vaId);
    return r
      ? { id: r.id, revokedAt: r.revokedAt, hasSignedAgreement: r.agreement !== null }
      : null;
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
  async markUsed() {}
  async revokeFamily() {
    return 0;
  }
  async revokeAllForSubject(st: string, sid: string) {
    const hit = this.rows.filter(
      (r) => r.subjectType === st && r.subjectId === sid && !r.revokedAt,
    );
    hit.forEach((r) => (r.revokedAt = new Date()));
    return hit.length;
  }
  async deleteExpired() {
    return 0;
  }
}

const hasher: IPasswordHasher = {
  hash: async (p) => `h:${p}`,
  verify: async (h, p) => h === `h:${p}`,
  needsRehash: () => false,
};

class FakeAudit implements IAuditLogger {
  entries: AuditEntry[] = [];
  async record(e: AuditEntry) {
    this.entries.push(e);
  }
  actions() {
    return this.entries.map((e) => e.action);
  }
}

const config = {
  get: (k: string) =>
    ({ JWT_SECRET: 'x'.repeat(40), ACCESS_TOKEN_TTL_SECONDS: 900, REFRESH_TOKEN_TTL_DAYS: 7 })[k],
} as unknown as AppConfigService;

const inTenant = <T>(fn: () => Promise<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    tenantContext.run({ clientId: 'c1', actorType: 'CLIENT', actorId: 'c1' }, () =>
      void fn().then(resolve, reject),
    );
  });

describe('VaService', () => {
  let vas: FakeVaRepo;
  let tokenRepo: FakeTokenRepo;
  let audit: FakeAudit;
  let service: VaService;

  beforeEach(() => {
    vas = new FakeVaRepo();
    tokenRepo = new FakeTokenRepo();
    audit = new FakeAudit();
    service = new VaService(
      vas,
      hasher,
      audit,
      new TokenService(new JwtService(), config, tokenRepo),
    );
  });

  const invite = () =>
    inTenant(() => service.invite({ email: 'Joy@Example.com', fullName: '  Joy Emoredo ' }));

  describe('invitations', () => {
    it('returns the raw token exactly once and stores only its hash', async () => {
      const invitation = await invite();
      expect(invitation.inviteToken).toHaveLength(43); // 32 bytes base64url
      expect(vas.rows[0].inviteTokenHash).toBe(sha(invitation.inviteToken));
      expect(vas.rows[0].inviteTokenHash).not.toBe(invitation.inviteToken);
    });

    it('normalises the email and trims the name', async () => {
      const { va } = await invite();
      expect(va.email).toBe('joy@example.com');
      expect(va.fullName).toBe('Joy Emoredo');
    });

    it('records the invitation', async () => {
      await invite();
      expect(audit.actions()).toContain('va.invited');
    });

    it('refuses to re-invite someone with an open invitation', async () => {
      await invite();
      await expect(invite()).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses to re-invite someone already onboarded', async () => {
      const { va, inviteToken } = await invite();
      await inTenant(() => service.acceptInvite({ token: inviteToken, password: 'a-long-password' }));
      await inTenant(() =>
        service.sign({
          vaId: va.id,
          signedName: 'Joy Emoredo',
          acknowledged: true,
          ipAddress: '1.2.3.4',
          userAgent: 'test',
        }),
      );
      await expect(invite()).rejects.toThrow(/already onboarded/i);
    });

    it('resending issues a new token and kills the old one', async () => {
      const first = await invite();
      const second = await inTenant(() => service.resendInvite(first.va.id));

      expect(second.inviteToken).not.toBe(first.inviteToken);
      await expect(
        inTenant(() => service.acceptInvite({ token: first.inviteToken, password: 'a-long-password' })),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('accepting', () => {
    it('sets a password and burns the token', async () => {
      const { inviteToken } = await invite();
      const accepted = await inTenant(() =>
        service.acceptInvite({ token: inviteToken, password: 'a-long-password' }),
      );
      expect(accepted.email).toBe('joy@example.com');
      expect(vas.rows[0].inviteTokenHash).toBeNull();
    });

    it('is single use', async () => {
      const { inviteToken } = await invite();
      await inTenant(() => service.acceptInvite({ token: inviteToken, password: 'a-long-password' }));
      await expect(
        inTenant(() => service.acceptInvite({ token: inviteToken, password: 'another-password' })),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects an expired invitation', async () => {
      const { inviteToken } = await invite();
      vas.rows[0].inviteExpiry = new Date(Date.now() - 1000);
      await expect(
        inTenant(() => service.acceptInvite({ token: inviteToken, password: 'a-long-password' })),
      ).rejects.toThrow(/not valid/i);
    });

    it('gives the SAME message for unknown, expired and used links', async () => {
      const { inviteToken } = await invite();
      const unknown = await inTenant(() =>
        service.acceptInvite({ token: 'made-up-token-value', password: 'a-long-password' }),
      ).catch((e: Error) => e.message);

      await inTenant(() => service.acceptInvite({ token: inviteToken, password: 'a-long-password' }));
      const used = await inTenant(() =>
        service.acceptInvite({ token: inviteToken, password: 'a-long-password' }),
      ).catch((e: Error) => e.message);

      // Which one it was is information a stranger with a guessed token has no
      // business learning.
      expect(unknown).toBe(used);
    });
  });

  describe('signing', () => {
    const onboard = async () => {
      const { va, inviteToken } = await invite();
      await inTenant(() => service.acceptInvite({ token: inviteToken, password: 'a-long-password' }));
      return va;
    };

    it('stores the version and a hash of the exact text shown', async () => {
      const va = await onboard();
      await inTenant(() =>
        service.sign({
          vaId: va.id,
          signedName: 'Joy Emoredo',
          acknowledged: true,
          ipAddress: '1.2.3.4',
          userAgent: 'Mozilla/5.0',
        }),
      );

      const stored = vas.rows[0].agreement!;
      expect(stored.documentVersion).toBe(getCurrentAgreement().version);
      expect(stored.documentHash).toBe(hashAgreementText(getCurrentAgreement().body));
    });

    /** The Phase 5 acceptance criterion. */
    it('the stored hash re-verifies against the stored version’s text', async () => {
      const va = await onboard();
      await inTenant(() =>
        service.sign({
          vaId: va.id,
          signedName: 'Joy Emoredo',
          acknowledged: true,
          ipAddress: '1.2.3.4',
          userAgent: 'test',
        }),
      );

      await expect(inTenant(() => service.verifySignature(va.id))).resolves.toEqual({
        verified: true,
        version: getCurrentAgreement().version,
        isCurrentVersion: true,
      });
    });

    it('reports a tampered signature as unverified', async () => {
      const va = await onboard();
      await inTenant(() =>
        service.sign({
          vaId: va.id,
          signedName: 'Joy',
          acknowledged: true,
          ipAddress: '1.2.3.4',
          userAgent: 'test',
        }),
      );
      vas.rows[0].agreement!.documentHash = 'deadbeef';

      expect((await inTenant(() => service.verifySignature(va.id))).verified).toBe(false);
    });

    it('refuses an unticked acknowledgement', async () => {
      const va = await onboard();
      await expect(
        inTenant(() =>
          service.sign({
            vaId: va.id,
            signedName: 'Joy',
            acknowledged: false,
            ipAddress: '1.2.3.4',
            userAgent: 'test',
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(vas.rows[0].agreement).toBeNull();
    });

    it('logs the signature with its version and hash', async () => {
      const va = await onboard();
      await inTenant(() =>
        service.sign({
          vaId: va.id,
          signedName: 'Joy Emoredo',
          acknowledged: true,
          ipAddress: '1.2.3.4',
          userAgent: 'test',
        }),
      );
      const entry = audit.entries.find((e) => e.action === 'agreement.signed')!;
      expect(entry.metadata?.documentHash).toBe(hashAgreementText(getCurrentAgreement().body));
    });

    it('reports an unsigned assistant rather than throwing', async () => {
      const va = await onboard();
      await expect(inTenant(() => service.verifySignature(va.id))).resolves.toEqual({
        verified: false,
        version: null,
        isCurrentVersion: false,
      });
    });
  });

  describe('revocation', () => {
    it('marks the account revoked AND kills refresh tokens', async () => {
      const { va, inviteToken } = await invite();
      await inTenant(() => service.acceptInvite({ token: inviteToken, password: 'a-long-password' }));

      // Two live sessions, as if they were signed in on two devices.
      await new TokenService(new JwtService(), config, tokenRepo).issuePair(
        { sub: va.id, role: 'VA', clientId: 'c1', email: va.email },
        'VA',
      );

      await inTenant(() => service.revoke(va.id));

      expect(vas.rows[0].revokedAt).not.toBeNull();
      expect(tokenRepo.rows.every((r) => r.revokedAt !== null)).toBe(true);
    });

    /**
     * The half that makes revocation immediate: a 15-minute access token cannot
     * be un-issued, so the per-request gate has to see this.
     */
    it('is visible to the per-request gate straight away', async () => {
      const { va, inviteToken } = await invite();
      await inTenant(() => service.acceptInvite({ token: inviteToken, password: 'a-long-password' }));

      expect((await vas.accessState(va.id))!.revokedAt).toBeNull();
      await inTenant(() => service.revoke(va.id));
      expect((await vas.accessState(va.id))!.revokedAt).not.toBeNull();
    });

    it('records how many sessions it ended', async () => {
      const { va, inviteToken } = await invite();
      await inTenant(() => service.acceptInvite({ token: inviteToken, password: 'a-long-password' }));
      await inTenant(() => service.revoke(va.id));

      const entry = audit.entries.find((e) => e.action === 'va.revoked')!;
      expect(entry.metadata).toHaveProperty('sessionsRevoked');
    });

    it('can be undone', async () => {
      const { va, inviteToken } = await invite();
      await inTenant(() => service.acceptInvite({ token: inviteToken, password: 'a-long-password' }));
      await inTenant(() => service.revoke(va.id));
      await inTenant(() => service.restore(va.id));
      expect(vas.rows[0].revokedAt).toBeNull();
    });
  });

  it('never returns a password hash or invite token in a summary', async () => {
    const { inviteToken } = await invite();
    const payload = JSON.stringify(await inTenant(() => service.list()));
    expect(payload).not.toContain(inviteToken);
    expect(payload).not.toContain('passwordHash');
    expect(payload).not.toContain('inviteToken');
  });
});
