import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { VA_REPOSITORY, type IVaRepository, type VaSummary } from './va.repository';
import { PASSWORD_HASHER, type IPasswordHasher } from '../auth/password.interface';
import { TokenService } from '../auth/token.service';
import { AUDIT_LOGGER, type IAuditLogger } from '../../core/audit/audit.interface';
import {
  CURRENT_AGREEMENT_VERSION,
  getCurrentAgreement,
  hashAgreementText,
  verifyAgreementHash,
} from './agreement/letter-of-engagement';

/** Seven days. Long enough to get around to it, short enough to matter. */
const INVITE_TTL_MS = 7 * 86_400_000;

export interface Invitation {
  va: VaSummary;
  /**
   * The raw token, returned ONCE, at creation.
   *
   * Only the hash is stored, for the same reason refresh tokens are hashed: a
   * database dump should not hand over live invitations. The Client puts this
   * in the link they send; nothing can recover it afterwards, which is why
   * "resend" issues a new one rather than re-showing the old.
   */
  inviteToken: string;
  expiresAt: Date;
}

@Injectable()
export class VaService {
  constructor(
    @Inject(VA_REPOSITORY) private readonly vas: IVaRepository,
    @Inject(PASSWORD_HASHER) private readonly passwords: IPasswordHasher,
    @Inject(AUDIT_LOGGER) private readonly audit: IAuditLogger,
    private readonly tokens: TokenService,
  ) {}

  async list(): Promise<VaSummary[]> {
    return this.vas.list();
  }

  async invite(input: { email: string; fullName: string }): Promise<Invitation> {
    const email = input.email.trim().toLowerCase();
    const existing = await this.vas.findByEmail(email);

    const raw = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

    let va: VaSummary;
    if (existing) {
      if (existing.agreement || !existing.revokedAt) {
        // Already onboarded, or already invited and still active. Re-inviting
        // would silently reset their access; make the Client say what they mean.
        throw new ConflictException(
          existing.agreement
            ? 'That assistant is already onboarded. Revoke them first if you want to start again.'
            : 'That assistant already has an open invitation. Resend it instead.',
        );
      }
      va = await this.vas.refreshInvite(existing.id, hashToken(raw), expiresAt);
    } else {
      va = await this.vas.invite({
        email,
        fullName: input.fullName.trim(),
        inviteTokenHash: hashToken(raw),
        inviteExpiry: expiresAt,
      });
    }

    await this.audit.record({
      action: 'va.invited',
      subjectType: 'VirtualAssistant',
      subjectId: va.id,
      metadata: { email, expiresAt: expiresAt.toISOString() },
    });

    return { va, inviteToken: raw, expiresAt };
  }

  /** Issues a fresh link. The old one stops working. */
  async resendInvite(vaId: string): Promise<Invitation> {
    const va = await this.requireVa(vaId);
    if (va.agreement) {
      throw new ConflictException('That assistant has already onboarded.');
    }

    const raw = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    const refreshed = await this.vas.refreshInvite(vaId, hashToken(raw), expiresAt);

    return { va: refreshed, inviteToken: raw, expiresAt };
  }

  async acceptInvite(input: {
    token: string;
    password: string;
  }): Promise<{ id: string; clientId: string; email: string; fullName: string }> {
    const accepted = await this.vas.acceptInvite(
      hashToken(input.token),
      await this.passwords.hash(input.password),
      new Date(),
    );

    if (!accepted) {
      // Unknown, expired, already used, or revoked — all one message. Which of
      // those it was is information a stranger holding a guessed token has no
      // business learning.
      throw new UnauthorizedException(
        'That invitation link is not valid. It may have expired or already been ' +
          'used. Ask the account owner to send a new one.',
      );
    }
    return accepted;
  }

  // ─────────────────────────────────────────────────────────── agreement

  /** The text to display. The VA signs exactly this. */
  currentAgreement() {
    const agreement = getCurrentAgreement();
    return {
      version: agreement.version,
      title: agreement.title,
      body: agreement.body,
      effectiveFrom: agreement.effectiveFrom,
    };
  }

  async sign(input: {
    vaId: string;
    signedName: string;
    acknowledged: boolean;
    ipAddress: string;
    userAgent: string;
  }): Promise<{ signedAt: Date; version: string }> {
    if (!input.acknowledged) {
      throw new ForbiddenException(
        'You have to confirm you have read the agreement before continuing.',
      );
    }

    const agreement = getCurrentAgreement();
    // Hash the text as it exists now, which is the text that was served. The
    // stored version plus this hash is what makes the signature provable rather
    // than merely asserted.
    const documentHash = hashAgreementText(agreement.body);

    await this.vas.signAgreement({
      vaId: input.vaId,
      documentVersion: agreement.version,
      documentHash,
      signedName: input.signedName.trim(),
      ipAddress: input.ipAddress,
      userAgent: input.userAgent.slice(0, 500),
    });

    await this.audit.record({
      action: 'agreement.signed',
      subjectType: 'VirtualAssistant',
      subjectId: input.vaId,
      metadata: {
        documentVersion: agreement.version,
        documentHash,
        signedName: input.signedName.trim(),
      },
      ipAddress: input.ipAddress,
    });

    return { signedAt: new Date(), version: agreement.version };
  }

  /**
   * Re-hashes the stored version's text and compares it to what was recorded.
   *
   * The Phase 5 acceptance criterion. Surfaced to the Client so they can see the
   * signature still verifies, rather than taking the database's word for it.
   */
  async verifySignature(vaId: string): Promise<{
    verified: boolean;
    version: string | null;
    isCurrentVersion: boolean;
  }> {
    const va = await this.requireVa(vaId);
    if (!va.agreement) return { verified: false, version: null, isCurrentVersion: false };

    return {
      verified: verifyAgreementHash(va.agreement.documentVersion, va.agreement.documentHash),
      version: va.agreement.documentVersion,
      isCurrentVersion: va.agreement.documentVersion === CURRENT_AGREEMENT_VERSION,
    };
  }

  // ───────────────────────────────────────────────────────── revocation

  /**
   * Revokes access immediately.
   *
   * Two things have to happen and both matter. Refresh tokens are revoked so no
   * new access token can be minted. And `revokedAt` is set, which the
   * per-request AgreementGuard reads — so the 15-minute access token already in
   * the VA's browser stops working on the very next request rather than when it
   * expires. "Within one request cycle, not at next expiry" is that second part.
   */
  async revoke(vaId: string): Promise<void> {
    const va = await this.requireVa(vaId);
    await this.vas.revoke(vaId);
    const killed = await this.tokens.revokeAllSessions('VA', vaId);

    await this.audit.record({
      action: 'va.revoked',
      subjectType: 'VirtualAssistant',
      subjectId: vaId,
      metadata: { email: va.email, sessionsRevoked: killed },
    });
  }

  async restore(vaId: string): Promise<void> {
    await this.requireVa(vaId);
    await this.vas.restore(vaId);
  }

  private async requireVa(vaId: string): Promise<VaSummary> {
    const va = await this.vas.find(vaId);
    if (!va) throw new NotFoundException('Assistant not found');
    return va;
  }
}

/**
 * sha256, not argon2 — the token is 256 bits of CSPRNG output, so there is
 * nothing to brute-force, and invite lookup is a hot-ish path. Same reasoning
 * as refresh tokens.
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
