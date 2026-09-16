import { Injectable } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { AppConfigService } from '../config/app-config.service';
import type { CipherEnvelope, ICredentialCipher } from './cipher.interface';

const ALGORITHM = 'aes-256-gcm';

/**
 * The HKDF domain separator. DO NOT CHANGE IT — not to match a rename, not to
 * tidy it up.
 *
 * It is an input to every data key this class has ever derived, so it is baked
 * into every ciphertext in the database. Change it and every stored credential,
 * every BYOK key and every sensitive profile value stops decrypting — not with
 * a clear error, but as an authentication failure, which reads like tampering
 * and sends whoever is on call looking for an attacker.
 *
 * It deliberately kept its original value through the rename to Understudy. The
 * product name is branding; this is a cryptographic constant that happens to
 * look like one. If it ever genuinely has to change, that is a key rotation
 * with a re-encryption pass, not an edit.
 */
const HKDF_DOMAIN = 'jaa';
const IV_BYTES = 12; // 96 bits — the size GCM is specified for
const KEY_BYTES = 32;


/**
 * AES-256-GCM with per-record derived data keys.
 *
 * The master key from the environment is never used to encrypt directly. Each
 * record gets its own key derived via HKDF from (master key, random salt), and
 * the salt travels with the record inside the IV field's associated data. This
 * bounds the blast radius of any single ciphertext being cracked and keeps us
 * well clear of GCM's per-key invocation limits.
 *
 * Plaintext exists only inside this class and only for the duration of one call.
 */
@Injectable()
export class AesGcmCipher implements ICredentialCipher {
  /**
   * Version → master key.
   *
   * More than one entry only during a rotation. A record's `keyVersion` selects
   * which key reads it, so old and new rows are both readable for as long as
   * the previous key is configured — which is what lets the re-encryption run
   * incrementally against a live system instead of needing a flag day.
   */
  private readonly keys = new Map<number, Buffer>();
  private readonly current: number;

  constructor(config: AppConfigService) {
    this.current = config.get('ENCRYPTION_KEY_VERSION');
    this.keys.set(this.current, requireKeyBytes(config.encryptionKey, 'ENCRYPTION_KEY'));

    const previous = config.get('ENCRYPTION_KEY_PREVIOUS');
    const previousVersion = config.get('ENCRYPTION_KEY_PREVIOUS_VERSION');
    if (previous && previousVersion !== undefined) {
      this.keys.set(
        previousVersion,
        requireKeyBytes(Buffer.from(previous, 'base64'), 'ENCRYPTION_KEY_PREVIOUS'),
      );
    }
  }

  get currentKeyVersion(): number {
    return this.current;
  }

  /** Which versions this process can read. The rotation command reports on it. */
  get readableKeyVersions(): number[] {
    return [...this.keys.keys()].sort((a, b) => a - b);
  }

  async encrypt(plaintext: string): Promise<CipherEnvelope> {
    const salt = randomBytes(16);
    const iv = randomBytes(IV_BYTES);
    const dataKey = this.deriveKey(salt, this.current);

    const cipher = createCipheriv(ALGORITHM, dataKey, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);

    dataKey.fill(0);

    return {
      // Salt is prefixed so the envelope stays a single opaque blob to callers.
      ciphertext: Buffer.concat([salt, ciphertext]),
      iv,
      authTag: cipher.getAuthTag(),
      keyVersion: this.current,
    };
  }

  async decrypt(envelope: CipherEnvelope): Promise<string> {
    const salt = envelope.ciphertext.subarray(0, 16);
    const payload = envelope.ciphertext.subarray(16);
    const dataKey = this.deriveKey(salt, envelope.keyVersion);

    const decipher = createDecipheriv(ALGORITHM, dataKey, envelope.iv);
    decipher.setAuthTag(envelope.authTag);

    try {
      const plaintext = Buffer.concat([
        decipher.update(payload),
        decipher.final(),
      ]).toString('utf8');
      return plaintext;
    } catch {
      // Never echo the envelope or any part of it into the error — it ends up
      // in logs. The caller learns only that authentication failed.
      throw new Error('Decryption failed: ciphertext failed authentication');
    } finally {
      dataKey.fill(0);
    }
  }

  /**
   * Constant-time comparison helper for any future credential verification.
   * Exposed here so nothing elsewhere reaches for `===` on a secret.
   */
  static equals(a: Buffer, b: Buffer): boolean {
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /**
   * The version selects the master key AND the HKDF info string.
   *
   * Both, deliberately. The info string alone was the old behaviour and it
   * meant "rotation" re-derived from the same master secret — new data keys,
   * same thing to steal. The key lookup is what makes a version change mean
   * something; the info string staying in keeps every version's derivations
   * domain-separated from every other's.
   */
  private deriveKey(salt: Buffer, keyVersion: number): Buffer {
    const masterKey = this.keys.get(keyVersion);
    if (!masterKey) {
      // Names the version and nothing else. Which versions this process holds
      // is operational detail that does not belong in an error a caller sees.
      throw new UnknownKeyVersionError(keyVersion);
    }
    return Buffer.from(
      hkdfSync('sha256', masterKey, salt, `${HKDF_DOMAIN}:v${keyVersion}`, KEY_BYTES),
    );
  }
}

/**
 * Thrown when a record was encrypted under a key this process does not hold.
 *
 * In practice: the previous key was removed from the environment before every
 * record had moved off it. Distinct from an authentication failure because the
 * remedy is completely different — put the key back and finish the rotation,
 * rather than suspect tampering.
 */
export class UnknownKeyVersionError extends Error {
  constructor(readonly keyVersion: number) {
    super(
      `No encryption key configured for keyVersion ${keyVersion}. ` +
        'If a rotation is in progress, ENCRYPTION_KEY_PREVIOUS was removed too early.',
    );
    this.name = 'UnknownKeyVersionError';
  }
}

function requireKeyBytes(key: Buffer, name: string): Buffer {
  // Defence in depth: env validation already checks this, but this class must
  // never operate on a short key even if wired up some other way.
  if (key.length !== KEY_BYTES) throw new Error(`${name} must be exactly 32 bytes`);
  return key;
}
