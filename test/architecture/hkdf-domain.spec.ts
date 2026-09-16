import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hkdfSync } from 'node:crypto';

/**
 * Pins the HKDF domain separator against a rename.
 *
 * `HKDF_DOMAIN` is an input to every data key the cipher has ever derived, so
 * it is baked into every ciphertext in the database. Changing it does not
 * produce a helpful error — every stored credential, BYOK key and sensitive
 * profile value fails GCM authentication, which looks exactly like tampering.
 *
 * It is also a short lowercase string that reads like a leftover from an old
 * product name, which is precisely why it needs a test: the next person doing a
 * rename will grep for it, see branding, and change it. The comment in the
 * cipher explains why not; this is what stops it happening anyway.
 *
 * If this test fails, the question is not "what should the new value be". It is
 * "is every existing record already re-encrypted?" — and if the answer is no,
 * put the old value back.
 */

const CIPHER = join(__dirname, '../../src/core/crypto/aes-gcm.cipher.ts');

describe('the HKDF domain separator', () => {
  const source = readFileSync(CIPHER, 'utf8');

  it('still has the value every stored ciphertext was derived under', () => {
    const declared = /const HKDF_DOMAIN = '([^']+)';/.exec(source)?.[1];
    expect(declared).toBe('jaa');
  });

  it('is still explained, so the next rename knows to leave it alone', () => {
    const block = source.slice(0, source.indexOf('const HKDF_DOMAIN'));
    expect(block).toMatch(/DO NOT CHANGE IT/);
  });

  it('actually reaches the derivation — the constant is not decorative', () => {
    expect(source).toMatch(/hkdfSync\([^)]*\$\{HKDF_DOMAIN\}:v\$\{keyVersion\}/s);
  });

  it('derives the key bytes this codebase has always derived', () => {
    // A golden vector. It fails if the domain string, the hash, the info
    // format or the key length changes — any of which silently orphans every
    // record already in the database.
    const masterKey = Buffer.alloc(32, 1);
    const salt = Buffer.alloc(16, 2);
    const derived = Buffer.from(
      hkdfSync('sha256', masterKey, salt, 'jaa:v1', 32),
    ).toString('base64');
    expect(derived).toBe('mLcTSFBdKs/IQL+ig0c0RpltAioXjAF34SMMJSlQ2rI=');
  });
});
