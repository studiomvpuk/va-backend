import type { CipherEnvelope } from '../core/crypto/cipher.interface';

/**
 * The credential vault, split into two interfaces that are deliberately not
 * interchangeable.
 *
 * PRD Phase 3: "ICredentialRepository as provided to VA-reachable code exposes
 * no method returning more than one record — verified by an architecture test,
 * not a convention."
 *
 * That is the whole design. `ICredentialRevealer` is the only thing a VA route
 * can reach, it has exactly one method, and that method returns one credential
 * or nothing. There is no findMany, no list, no batch variant, and no method
 * taking an array of ids — not because callers are trusted to avoid them, but
 * because they do not exist to be called.
 *
 * `test/architecture/credential-access.spec.ts` fails CI if that stops being
 * true.
 */

export interface StoredCredentialMeta {
  id: string;
  siteId: string;
  /** Username is not a secret — the Client sees it in the sites list. */
  hasPassword: boolean;
  rotatedAt: Date | null;
  createdAt: Date;
}

/** What a VA receives. One site, one password, once. */
export interface RevealedCredential {
  revealId: string;
  siteName: string;
  username: string;
  password: string;
  /** When the client-side auto-hide should fire. */
  expiresAt: Date;
}

export interface ICredentialRevealer {
  /**
   * Decrypts the credential for ONE site and records the access in the same
   * transaction.
   *
   * Returns null when the site has no credential. Throws when the VA is not
   * permitted — see the §7.4 gate in VaultService.
   */
  revealForSite(input: {
    siteId: string;
    vaId: string;
    ipAddress?: string;
    ttlSeconds: number;
  }): Promise<RevealedCredential | null>;
}

/** Client-side management. Never injected into anything a VA can reach. */
export interface ICredentialWriter {
  put(siteId: string, envelope: CipherEnvelope, rotated: boolean): Promise<void>;
  remove(siteId: string): Promise<void>;
  findMeta(siteId: string): Promise<StoredCredentialMeta | null>;
  listMeta(): Promise<StoredCredentialMeta[]>;

  /** Marks every still-live reveal of this credential stale. */
  supersedeLiveReveals(credentialId: string): Promise<number>;

  acknowledgeUnrotated(credentialId: string, vaId: string): Promise<void>;
  hasAcknowledgement(credentialId: string, vaId: string): Promise<boolean>;

  /** For the countdown component: has this reveal been overtaken? */
  isRevealSuperseded(revealId: string): Promise<boolean>;
}

export const CREDENTIAL_REVEALER = Symbol('CREDENTIAL_REVEALER');
export const CREDENTIAL_WRITER = Symbol('CREDENTIAL_WRITER');
