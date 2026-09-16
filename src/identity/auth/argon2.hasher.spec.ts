import { Argon2Hasher } from './argon2.hasher';

/**
 * Exercises the real KDF. Slower than the rest of the suite (argon2 is
 * deliberately expensive) but this is the one place where "it hashes properly"
 * cannot be taken on trust from a fake.
 */
describe('Argon2Hasher', () => {
  const hasher = new Argon2Hasher();
  jest.setTimeout(20_000);

  it('produces a hash that does not contain the password', async () => {
    const hash = await hasher.hash('correct-horse-battery-staple');
    expect(hash).not.toContain('correct-horse');
    expect(hash).toMatch(/^\$argon2id\$/);
  });

  it('salts: the same password hashes differently every time', async () => {
    const [a, b] = await Promise.all([hasher.hash('same-password'), hasher.hash('same-password')]);
    expect(a).not.toBe(b);
  });

  it('verifies the right password and rejects the wrong one', async () => {
    const hash = await hasher.hash('correct-horse-battery-staple');
    expect(await hasher.verify(hash, 'correct-horse-battery-staple')).toBe(true);
    expect(await hasher.verify(hash, 'Correct-horse-battery-staple')).toBe(false);
  });

  it('returns false rather than throwing on a malformed hash', async () => {
    // A corrupted row must read as a failed login, not a 500 that tells an
    // attacker they found something interesting.
    expect(await hasher.verify('not-a-hash', 'anything')).toBe(false);
    expect(await hasher.verify('', 'anything')).toBe(false);
    expect(await hasher.verify('$argon2id$v=19$m=1,t=1,p=1$bad', 'anything')).toBe(false);
  });

  describe('needsRehash', () => {
    it('is false for a hash it just produced', async () => {
      expect(hasher.needsRehash(await hasher.hash('a-password-here'))).toBe(false);
    });

    it('is true for weaker memory, time or parallelism', () => {
      expect(hasher.needsRehash('$argon2id$v=19$m=4096,t=2,p=1$c2FsdA$aGFzaA')).toBe(true);
      expect(hasher.needsRehash('$argon2id$v=19$m=19456,t=1,p=1$c2FsdA$aGFzaA')).toBe(true);
    });

    it('is FALSE for stronger parameters — rehashing down would be a downgrade', () => {
      expect(hasher.needsRehash('$argon2id$v=19$m=65536,t=4,p=2$c2FsdA$aGFzaA')).toBe(false);
    });

    it('is true for a different argon2 variant', () => {
      expect(hasher.needsRehash('$argon2i$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA')).toBe(true);
    });

    it('is true for anything unparseable', () => {
      expect(hasher.needsRehash('$2b$12$bcrypt.style.hash')).toBe(true);
      expect(hasher.needsRehash('')).toBe(true);
    });
  });
});
