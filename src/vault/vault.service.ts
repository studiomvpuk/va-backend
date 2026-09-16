import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CREDENTIAL_REVEALER,
  CREDENTIAL_WRITER,
  type ICredentialRevealer,
  type ICredentialWriter,
  type RevealedCredential,
} from './credential.repository';
import { SITE_REPOSITORY, type ISiteRepository, type SiteView } from './site.repository';
import {
  CREDENTIAL_CIPHER,
  type ICredentialCipher,
} from '../core/crypto/cipher.interface';
import { AUDIT_LOGGER, type IAuditLogger } from '../core/audit/audit.interface';
import {
  evaluateSharingGate,
  GATE_BLOCKED_MESSAGE,
  type GateVerdict,
} from './sharing-gate';

/**
 * How long a revealed password stays on screen.
 *
 * Not a security control in itself — the plaintext has already left the server
 * and the VA can copy it in under a second. It bounds how long a password sits
 * visible on a screen someone else might walk past, which is a real and much
 * more ordinary risk than a determined attacker.
 */
export const REVEAL_TTL_SECONDS = 60;

export interface SiteWithVaultState extends SiteView {
  hasPassword: boolean;
  rotatedAt: Date | null;
}

@Injectable()
export class VaultService {
  constructor(
    @Inject(SITE_REPOSITORY) private readonly sites: ISiteRepository,
    @Inject(CREDENTIAL_WRITER) private readonly credentials: ICredentialWriter,
    @Inject(CREDENTIAL_REVEALER) private readonly revealer: ICredentialRevealer,
    @Inject(CREDENTIAL_CIPHER) private readonly cipher: ICredentialCipher,
    @Inject(AUDIT_LOGGER) private readonly audit: IAuditLogger,
  ) {}

  // ─────────────────────────────────────────────────────────── Client side

  async listSites(): Promise<SiteWithVaultState[]> {
    const [sites, metas] = await Promise.all([
      this.sites.list(),
      this.credentials.listMeta(),
    ]);
    const bySite = new Map(metas.map((m) => [m.siteId, m]));
    return sites.map((site) => ({
      ...site,
      hasPassword: bySite.has(site.id),
      rotatedAt: bySite.get(site.id)?.rotatedAt ?? null,
    }));
  }

  async createSite(input: {
    name: string;
    url: string;
    username: string;
  }): Promise<SiteWithVaultState> {
    const site = await this.sites.create(input);
    return { ...site, hasPassword: false, rotatedAt: null };
  }

  async updateSite(
    id: string,
    changes: { name?: string; url?: string; username?: string },
  ): Promise<SiteWithVaultState> {
    await this.requireSite(id);
    const site = await this.sites.update(id, changes);
    const meta = await this.credentials.findMeta(id);
    return {
      ...site,
      hasPassword: meta !== null,
      rotatedAt: meta?.rotatedAt ?? null,
    };
  }

  async deleteSite(id: string): Promise<void> {
    await this.requireSite(id);
    await this.sites.remove(id);
  }

  /**
   * Sets or rotates the stored password.
   *
   * `rotate` is not cosmetic: it stamps `rotatedAt`, which is what the §7.4
   * gate reads, and it marks any reveal still on a VA's screen as stale so they
   * do not paste a password that stopped working while they were looking at it.
   */
  async setPassword(
    siteId: string,
    password: string,
    options: { rotate: boolean },
  ): Promise<SiteWithVaultState> {
    const site = await this.requireSite(siteId);
    const existing = await this.credentials.findMeta(siteId);

    // Setting a password where one already exists IS a rotation, whatever the
    // caller said — the old value has stopped being the current value.
    const isRotation = options.rotate || existing !== null;

    await this.credentials.put(siteId, await this.cipher.encrypt(password), isRotation);

    let superseded = 0;
    if (existing) superseded = await this.credentials.supersedeLiveReveals(existing.id);

    await this.audit.record({
      action: isRotation ? 'credential.rotated' : 'credential.revealed',
      subjectType: 'Site',
      subjectId: siteId,
      metadata: {
        siteName: site.name,
        // Never the password, never the ciphertext — only that it changed.
        rotated: isRotation,
        supersededLiveReveals: superseded,
      },
    });

    const meta = await this.credentials.findMeta(siteId);
    return {
      ...site,
      hasPassword: true,
      rotatedAt: meta?.rotatedAt ?? null,
      status: 'CONNECTED',
    };
  }

  async removePassword(siteId: string): Promise<void> {
    await this.requireSite(siteId);
    await this.credentials.remove(siteId);
  }

  /**
   * Records the Client's decision to share an un-rotated password with a VA.
   *
   * The dismissal is the audited event — §7.4 is explicit that choosing to
   * share without rotating is itself a decision worth keeping a record of.
   */
  async acknowledgeUnrotatedSharing(siteId: string, vaId: string): Promise<void> {
    const site = await this.requireSite(siteId);
    const meta = await this.credentials.findMeta(siteId);
    if (!meta) throw new NotFoundException('That site has no stored password');

    await this.credentials.acknowledgeUnrotated(meta.id, vaId);
    await this.audit.record({
      action: 'credential.shared_without_rotation',
      subjectType: 'Site',
      subjectId: siteId,
      metadata: {
        siteName: site.name,
        vaId,
        note: 'Client chose to share the existing password rather than rotate it',
      },
    });
  }

  /** What the UI needs to decide between "Rotate first" and "Share anyway". */
  async gateStatusFor(siteId: string, vaId: string): Promise<GateVerdict> {
    const meta = await this.credentials.findMeta(siteId);
    const va = await this.sites.findVa(vaId);
    if (!meta || !va) {
      return { allowed: false, reason: 'needs_rotation_or_acknowledgement' };
    }
    return evaluateSharingGate({
      credentialSetAt: meta.createdAt,
      credentialRotatedAt: meta.rotatedAt,
      vaOnboardedAt: va.createdAt,
      hasAcknowledgement: await this.credentials.hasAcknowledgement(meta.id, vaId),
    });
  }

  // ────────────────────────────────────────────────────────────── VA side

  /**
   * The scoped reveal. One site, one credential, logged.
   *
   * Everything a VA can reach goes through here, and there is no variant that
   * takes more than one site id.
   */
  async revealForVa(input: {
    siteId: string;
    vaId: string;
    ipAddress?: string;
  }): Promise<RevealedCredential> {
    const site = await this.sites.find(input.siteId);
    // 404 rather than 403 for a site outside this tenant: the tenant extension
    // has already made it unfindable, and confirming existence would leak that
    // a site by that id exists somewhere.
    if (!site) throw new NotFoundException('Site not found');

    const va = await this.sites.findVa(input.vaId);
    if (!va || va.revokedAt) throw new ForbiddenException('Access has been revoked');

    const meta = await this.credentials.findMeta(input.siteId);
    if (!meta) throw new NotFoundException('That site has no stored password yet');

    const verdict = evaluateSharingGate({
      credentialSetAt: meta.createdAt,
      credentialRotatedAt: meta.rotatedAt,
      vaOnboardedAt: va.createdAt,
      hasAcknowledgement: await this.credentials.hasAcknowledgement(meta.id, input.vaId),
    });

    if (!verdict.allowed) {
      // The VA is told to ask the Client; the reason is the Client's to act on.
      throw new ForbiddenException(
        'The account owner has not released this password yet. Ask them to ' +
          'rotate it or confirm sharing in their vault.',
      );
    }

    const revealed = await this.revealer.revealForSite({
      siteId: input.siteId,
      vaId: input.vaId,
      ipAddress: input.ipAddress,
      ttlSeconds: REVEAL_TTL_SECONDS,
    });
    if (!revealed) throw new NotFoundException('That site has no stored password yet');
    return revealed;
  }

  /** Polled once mid-countdown so a rotation mid-reveal is visible immediately. */
  async isRevealStale(revealId: string): Promise<boolean> {
    return this.credentials.isRevealSuperseded(revealId);
  }

  private async requireSite(id: string): Promise<SiteView> {
    const site = await this.sites.find(id);
    if (!site) throw new NotFoundException('Site not found');
    return site;
  }
}

export { GATE_BLOCKED_MESSAGE };
