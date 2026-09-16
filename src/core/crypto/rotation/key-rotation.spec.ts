import { AesGcmCipher, UnknownKeyVersionError } from '../aes-gcm.cipher';
import type { AppConfigService } from '../../config/app-config.service';

/**
 * The rotation the PRD acceptance describes: "re-encrypt under keyVersion 2,
 * both versions readable during the window, old version retired."
 *
 * Exercised against the real cipher with real keys, because the property under
 * test is cryptographic — that a v1 record is still readable while v2 is being
 * written, and stops being readable the moment the old key is withdrawn.
 */
const KEY_V1 = Buffer.alloc(32, 1).toString('base64');
const KEY_V2 = Buffer.alloc(32, 2).toString('base64');

function cipherFor(env: {
  key: string;
  version: number;
  previous?: string;
  previousVersion?: number;
}): AesGcmCipher {
  const config = {
    encryptionKey: Buffer.from(env.key, 'base64'),
    get: (name: string) => {
      switch (name) {
        case 'ENCRYPTION_KEY_VERSION':
          return env.version;
        case 'ENCRYPTION_KEY_PREVIOUS':
          return env.previous;
        case 'ENCRYPTION_KEY_PREVIOUS_VERSION':
          return env.previousVersion;
        default:
          return undefined;
      }
    },
  } as unknown as AppConfigService;
  return new AesGcmCipher(config);
}

const SECRET = 'correcthorsebatterystaple';

describe('key rotation', () => {
  it('before rotation: one key, one readable version', async () => {
    const cipher = cipherFor({ key: KEY_V1, version: 1 });

    expect(cipher.currentKeyVersion).toBe(1);
    expect(cipher.readableKeyVersions).toEqual([1]);

    const envelope = await cipher.encrypt(SECRET);
    expect(envelope.keyVersion).toBe(1);
    expect(await cipher.decrypt(envelope)).toBe(SECRET);
  });

  describe('during the window: v2 current, v1 still readable', () => {
    const before = cipherFor({ key: KEY_V1, version: 1 });
    const during = cipherFor({
      key: KEY_V2,
      version: 2,
      previous: KEY_V1,
      previousVersion: 1,
    });

    it('reads both versions', async () => {
      const old = await before.encrypt(SECRET);
      expect(during.readableKeyVersions).toEqual([1, 2]);
      expect(await during.decrypt(old)).toBe(SECRET);
    });

    it('writes new records at v2', async () => {
      const fresh = await during.encrypt(SECRET);
      expect(fresh.keyVersion).toBe(2);
      expect(await during.decrypt(fresh)).toBe(SECRET);
    });

    it('re-encrypting moves a record from v1 to v2', async () => {
      const old = await before.encrypt(SECRET);
      const plaintext = await during.decrypt(old);
      const rotated = await during.encrypt(plaintext);

      expect(rotated.keyVersion).toBe(2);
      expect(rotated.ciphertext.equals(old.ciphertext)).toBe(false);
      expect(await during.decrypt(rotated)).toBe(SECRET);
    });
  });

  describe('after retirement: v1 key withdrawn', () => {
    const after = cipherFor({ key: KEY_V2, version: 2 });

    it('reads only v2', () => {
      expect(after.readableKeyVersions).toEqual([2]);
    });

    it('reads a record that was rotated', async () => {
      const during = cipherFor({
        key: KEY_V2,
        version: 2,
        previous: KEY_V1,
        previousVersion: 1,
      });
      const rotated = await during.encrypt(SECRET);
      expect(await after.decrypt(rotated)).toBe(SECRET);
    });

    it('fails loudly, and distinctly, on a record left behind', async () => {
      // The remedy for "key withdrawn too early" is the opposite of the remedy
      // for "ciphertext tampered with", so the two must not look alike.
      const old = await cipherFor({ key: KEY_V1, version: 1 }).encrypt(SECRET);

      await expect(after.decrypt(old)).rejects.toBeInstanceOf(UnknownKeyVersionError);
      await expect(after.decrypt(old)).rejects.toThrow(/removed too early/);
    });
  });

  it('a v2 key genuinely cannot read v1 — the version is not just a label', async () => {
    // The old implementation derived every version from the SAME master key, so
    // "rotating" produced new data keys from the same secret. This asserts the
    // thing that makes rotation worth doing: the new key alone is not enough.
    const old = await cipherFor({ key: KEY_V1, version: 1 }).encrypt(SECRET);
    const wrongKeySameVersion = cipherFor({ key: KEY_V2, version: 1 });

    await expect(wrongKeySameVersion.decrypt(old)).rejects.toThrow(/failed authentication/);
  });

  it('rejects a short key however it is wired up', () => {
    const config = {
      encryptionKey: Buffer.alloc(16),
      get: () => 1,
    } as unknown as AppConfigService;

    expect(() => new AesGcmCipher(config)).toThrow(/exactly 32 bytes/);
  });
});
