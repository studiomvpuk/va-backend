/**
 * The encryption seam (PRD §2.4, Dependency Inversion).
 *
 * Every stored secret — credentials, BYOK API keys, sensitive profile values —
 * goes through this interface. Nothing outside CryptoModule knows or cares that
 * the current implementation is AES-256-GCM with the key in an environment
 * variable.
 *
 * This is the escape hatch for v10 Open Question 1: moving to a managed secrets
 * service later is one new class implementing this interface, not a migration
 * of every call site.
 */

export interface CipherEnvelope {
  /** The encrypted payload. */
  ciphertext: Buffer;
  /** Per-record initialisation vector. Never reused. */
  iv: Buffer;
  /** GCM authentication tag — detects tampering on decrypt. */
  authTag: Buffer;
  /**
   * Which master key version encrypted this record. Lets a rotation run
   * incrementally instead of requiring a flag day.
   */
  keyVersion: number;
}

export interface ICredentialCipher {
  encrypt(plaintext: string): Promise<CipherEnvelope>;
  decrypt(envelope: CipherEnvelope): Promise<string>;
  /** The version new records are written with. */
  readonly currentKeyVersion: number;
  /**
   * Every version this process can still decrypt.
   *
   * On the interface rather than the implementation because it is what makes a
   * rotation observable: the command reports it, and an operator removing the
   * previous key needs to see it drop back to one entry.
   */
  readonly readableKeyVersions: number[];
}

export const CREDENTIAL_CIPHER = Symbol('CREDENTIAL_CIPHER');
