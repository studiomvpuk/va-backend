import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { cipherConfig } from '../core/crypto/test-config';
import { VaultService, REVEAL_TTL_SECONDS } from './vault.service';
import { AesGcmCipher } from '../core/crypto/aes-gcm.cipher';
import type { CipherEnvelope } from '../core/crypto/cipher.interface';
import type { IAuditLogger, AuditEntry } from '../core/audit/audit.interface';
import type {
  ICredentialRevealer,
  ICredentialWriter,
  RevealedCredential,
  StoredCredentialMeta,
} from './credential.repository';
import type {
  ISiteRepository,
  SiteView,
  VaRecordForGate,
} from './site.repository';

const cipher = new AesGcmCipher(cipherConfig({ key: Buffer.alloc(32, 4) }));

class FakeSites implements ISiteRepository {
  sites: SiteView[] = [];
  vas: VaRecordForGate[] = [];
  private seq = 0;

  async list() {
    return this.sites.map((s) => ({ ...s }));
  }
  async find(id: string) {
    const s = this.sites.find((x) => x.id === id);
    return s ? { ...s } : null;
  }
  async create(i: { name: string; url: string; username: string }) {
    const s: SiteView = {
      id: `site${++this.seq}`,
      ...i,
      status: 'NOT_CONNECTED',
      createdAt: new Date(),
    };
    this.sites.push(s);
    return { ...s };
  }
  async update(id: string, changes: Partial<SiteView>) {
    const s = this.sites.find((x) => x.id === id)!;
    Object.assign(s, changes);
    return { ...s };
  }
  async remove(id: string) {
    this.sites = this.sites.filter((s) => s.id !== id);
  }
  async findVa(vaId: string) {
    return this.vas.find((v) => v.id === vaId) ?? null;
  }
}

class FakeCredentials implements ICredentialRevealer, ICredentialWriter {
  rows = new Map<
    string,
    { meta: StoredCredentialMeta; envelope: CipherEnvelope }
  >();
  acks = new Set<string>();
  reveals: { id: string; credentialId: string; superseded: boolean }[] = [];
  private seq = 0;

  constructor(private readonly sites: FakeSites) {}

  async put(siteId: string, envelope: CipherEnvelope, rotated: boolean) {
    const existing = this.rows.get(siteId);
    this.rows.set(siteId, {
      envelope,
      meta: {
        id: existing?.meta.id ?? `cred${++this.seq}`,
        siteId,
        hasPassword: true,
        createdAt: existing?.meta.createdAt ?? new Date(),
        rotatedAt: rotated ? new Date() : (existing?.meta.rotatedAt ?? null),
      },
    });
  }
  async remove(siteId: string) {
    this.rows.delete(siteId);
  }
  async findMeta(siteId: string) {
    const r = this.rows.get(siteId);
    return r ? { ...r.meta } : null;
  }
  async listMeta() {
    return [...this.rows.values()].map((r) => ({ ...r.meta }));
  }
  async supersedeLiveReveals(credentialId: string) {
    const live = this.reveals.filter((r) => r.credentialId === credentialId && !r.superseded);
    live.forEach((r) => (r.superseded = true));
    return live.length;
  }
  async acknowledgeUnrotated(credentialId: string, vaId: string) {
    this.acks.add(`${credentialId}:${vaId}`);
  }
  async hasAcknowledgement(credentialId: string, vaId: string) {
    return this.acks.has(`${credentialId}:${vaId}`);
  }
  async isRevealSuperseded(revealId: string) {
    return this.reveals.find((r) => r.id === revealId)?.superseded ?? false;
  }
  async revealForSite(input: {
    siteId: string;
    vaId: string;
    ttlSeconds: number;
  }): Promise<RevealedCredential | null> {
    const row = this.rows.get(input.siteId);
    if (!row) return null;
    const site = await this.sites.find(input.siteId);
    const reveal = {
      id: `rev${this.reveals.length + 1}`,
      credentialId: row.meta.id,
      superseded: false,
    };
    this.reveals.push(reveal);
    return {
      revealId: reveal.id,
      siteName: site!.name,
      username: site!.username,
      password: await cipher.decrypt(row.envelope),
      expiresAt: new Date(Date.now() + input.ttlSeconds * 1000),
    };
  }
}

class FakeAudit implements IAuditLogger {
  entries: AuditEntry[] = [];
  async record(entry: AuditEntry) {
    this.entries.push(entry);
  }
  actions() {
    return this.entries.map((e) => e.action);
  }
}

describe('VaultService', () => {
  let sites: FakeSites;
  let creds: FakeCredentials;
  let audit: FakeAudit;
  let vault: VaultService;

  beforeEach(() => {
    sites = new FakeSites();
    creds = new FakeCredentials(sites);
    audit = new FakeAudit();
    vault = new VaultService(sites, creds, creds, cipher, audit);
  });

  const addSite = () =>
    vault.createSite({
      name: 'Indeed UK',
      url: 'https://uk.indeed.com',
      username: 'olont.jobs@gmail.com',
    });

  const HOUR = 3_600_000;

  /**
   * A VA who joined AFTER the password was last set — so they would see a value
   * the Client was already using. This is the gate-blocked case.
   *
   * Real timestamps in the past, not a VA onboarded in the future: backdating
   * the credential is what makes a rotation "now" genuinely later, and an
   * earlier version of this fixture quietly made that impossible to express.
   */
  const backdateCredential = (siteId: string, hoursAgo: number) => {
    const row = creds.rows.get(siteId)!;
    row.meta.createdAt = new Date(Date.now() - hoursAgo * HOUR);
    row.meta.rotatedAt = null;
  };
  const addVaOnboardedHoursAgo = (hours: number, id = 'va_1') => {
    sites.vas.push({
      id,
      createdAt: new Date(Date.now() - hours * HOUR),
      revokedAt: null,
    });
    return id;
  };
  /** Credential set two hours ago, VA arrived one hour ago → blocked. */
  const addOldVa = (id = 'va_1') => addVaOnboardedHoursAgo(1, id);
  /** VA arrived before anything was stored → nothing to rotate. */
  const addNewVa = (id = 'va_new') => addVaOnboardedHoursAgo(1, id);

  describe('the Client never gets a password back', () => {
    it('is absent from the sites list', async () => {
      const site = await addSite();
      await vault.setPassword(site.id, 'k9-Tulip-Marlow-42', { rotate: false });

      const payload = JSON.stringify(await vault.listSites());
      expect(payload).not.toContain('Tulip');
      expect(payload).toContain('hasPassword');
    });

    it('is absent from the set-password response', async () => {
      const site = await addSite();
      const result = await vault.setPassword(site.id, 'k9-Tulip-Marlow-42', {
        rotate: false,
      });
      expect(JSON.stringify(result)).not.toContain('Tulip');
    });

    it('is never written into an audit entry', async () => {
      const site = await addSite();
      await vault.setPassword(site.id, 'k9-Tulip-Marlow-42', { rotate: true });
      expect(JSON.stringify(audit.entries)).not.toContain('Tulip');
    });
  });

  describe('the §7.4 gate', () => {
    it('refuses a VA onboarded after the password was last set', async () => {
      const site = await addSite();
      await vault.setPassword(site.id, 'old-password-value', { rotate: false });
      backdateCredential(site.id, 2);
      const vaId = addOldVa();

      await expect(
        vault.revealForVa({ siteId: site.id, vaId }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('releases it once the Client rotates', async () => {
      const site = await addSite();
      await vault.setPassword(site.id, 'old-password-value', { rotate: false });
      backdateCredential(site.id, 2);
      const vaId = addOldVa();

      await vault.setPassword(site.id, 'fresh-password-value', { rotate: true });

      const revealed = await vault.revealForVa({ siteId: site.id, vaId });
      expect(revealed.password).toBe('fresh-password-value');
    });

    it('releases it on an explicit, audited acknowledgement', async () => {
      const site = await addSite();
      await vault.setPassword(site.id, 'old-password-value', { rotate: false });
      backdateCredential(site.id, 2);
      const vaId = addOldVa();

      await vault.acknowledgeUnrotatedSharing(site.id, vaId);

      await expect(vault.revealForVa({ siteId: site.id, vaId })).resolves.toBeTruthy();
      expect(audit.actions()).toContain('credential.shared_without_rotation');
    });

    it('asks again for a second VA — one acknowledgement is not blanket consent', async () => {
      const site = await addSite();
      await vault.setPassword(site.id, 'old-password-value', { rotate: false });
      backdateCredential(site.id, 2);
      const first = addOldVa('va_1');
      const second = addOldVa('va_2');

      await vault.acknowledgeUnrotatedSharing(site.id, first);

      await expect(vault.revealForVa({ siteId: site.id, vaId: first })).resolves.toBeTruthy();
      await expect(
        vault.revealForVa({ siteId: site.id, vaId: second }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('does not block a credential added after the VA joined', async () => {
      const vaId = addNewVa();
      const site = await addSite();
      await vault.setPassword(site.id, 'brand-new-password', { rotate: false });

      await expect(vault.revealForVa({ siteId: site.id, vaId })).resolves.toBeTruthy();
    });
  });

  describe('reveal', () => {
    it('returns one credential, scoped to the site asked for', async () => {
      const a = await addSite();
      const b = await vault.createSite({
        name: 'Reed',
        url: 'https://reed.co.uk',
        username: 'olont.jobs@gmail.com',
      });
      await vault.setPassword(a.id, 'password-for-indeed', { rotate: false });
      await vault.setPassword(b.id, 'password-for-reed', { rotate: false });
      const vaId = addNewVa();

      const revealed = await vault.revealForVa({ siteId: a.id, vaId });
      expect(revealed.password).toBe('password-for-indeed');
      // Nothing about the other site came back with it.
      expect(JSON.stringify(revealed)).not.toContain('reed');
    });

    it('is time-boxed', async () => {
      const site = await addSite();
      await vault.setPassword(site.id, 'a-password', { rotate: false });
      const vaId = addNewVa();

      const revealed = await vault.revealForVa({ siteId: site.id, vaId });
      const seconds = (revealed.expiresAt.getTime() - Date.now()) / 1000;
      expect(seconds).toBeGreaterThan(REVEAL_TTL_SECONDS - 5);
      expect(seconds).toBeLessThanOrEqual(REVEAL_TTL_SECONDS);
    });

    it('refuses a revoked VA', async () => {
      const site = await addSite();
      await vault.setPassword(site.id, 'a-password', { rotate: false });
      const vaId = addNewVa();
      sites.vas[0].revokedAt = new Date();

      await expect(
        vault.revealForVa({ siteId: site.id, vaId }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('404s for a site with no stored password', async () => {
      const site = await addSite();
      const vaId = addNewVa();
      await expect(
        vault.revealForVa({ siteId: site.id, vaId }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s rather than 403s for an unknown site — existence is not confirmed', async () => {
      const vaId = addNewVa();
      await expect(
        vault.revealForVa({ siteId: 'site_from_another_tenant', vaId }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('rotation during a live reveal', () => {
    it('marks the reveal stale so the VA is not left pasting a dead password', async () => {
      const site = await addSite();
      await vault.setPassword(site.id, 'original-password', { rotate: false });
      const vaId = addNewVa();

      const revealed = await vault.revealForVa({ siteId: site.id, vaId });
      expect(await vault.isRevealStale(revealed.revealId)).toBe(false);

      await vault.setPassword(site.id, 'rotated-password', { rotate: true });

      expect(await vault.isRevealStale(revealed.revealId)).toBe(true);
    });

    it('records how many live reveals it overtook', async () => {
      const site = await addSite();
      await vault.setPassword(site.id, 'original-password', { rotate: false });
      const vaId = addNewVa();
      await vault.revealForVa({ siteId: site.id, vaId });

      await vault.setPassword(site.id, 'rotated-password', { rotate: true });

      const rotation = audit.entries.find((e) => e.action === 'credential.rotated')!;
      expect(rotation.metadata?.supersededLiveReveals).toBe(1);
    });

    it('treats replacing an existing password as a rotation even when not asked', async () => {
      const site = await addSite();
      await vault.setPassword(site.id, 'first-password', { rotate: false });
      await vault.setPassword(site.id, 'second-password', { rotate: false });

      const meta = await creds.findMeta(site.id);
      // The old value stopped being current, so the timestamp has to move —
      // otherwise the §7.4 gate would keep blocking after a real change.
      expect(meta?.rotatedAt).not.toBeNull();
    });
  });
});
