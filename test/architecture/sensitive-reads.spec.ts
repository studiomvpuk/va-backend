import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Pins the one door.
 *
 * The invariant: exactly one code path turns a stored sensitive ciphertext back
 * into plaintext, and it writes an audit row in the same transaction.
 *
 * Two things could break that. Someone could add a `sensitiveValue` query
 * somewhere new, or someone could select the `ciphertext` column from a file
 * that has no business decrypting it. This test catches both.
 *
 * The same reasoning applies to Credential in Phase 3, which is why the
 * allowlist is keyed by model rather than hardcoded to one.
 */
const PROTECTED_MODELS = {
  sensitiveValue: ['src/disclosure/prisma-sensitive-value.repository.ts'],
} as const;

/**
 * Files permitted to decrypt, each for exactly one model.
 *
 * Phase 3 added two more encrypted things — site credentials and BYOK provider
 * keys — so "only one file in the codebase decrypts anything" stopped being
 * true. The invariant did not change shape, it just applies per model: one
 * reader each, and none of them can reach another's ciphertext because none of
 * them queries another's model. `credential-access.spec.ts` asserts the same
 * three-way split from the credential side.
 */
const CIPHERTEXT_READERS: Record<string, string> = {
  'src/disclosure/prisma-sensitive-value.repository.ts': 'sensitiveValue',
  'src/vault/prisma-credential.repository.ts': 'credential',
  'src/keyring/prisma-provider-key.repository.ts': 'providerKey',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.ts$/.test(entry) && !/\.spec\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

describe('sensitive value access', () => {
  const root = join(__dirname, '../..');
  const files = walk(join(root, 'src')).map((f) => ({
    path: relative(root, f).replace(/\\/g, '/'),
    source: readFileSync(f, 'utf8'),
  }));

  it('finds source to check', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  describe.each(Object.entries(PROTECTED_MODELS))('%s', (model, allowed) => {
    it('is queried only from the allowlisted files', () => {
      const callers = files
        .filter((f) => new RegExp(`\\.${model}\\.`).test(f.source))
        .map((f) => f.path);
      expect(callers.sort()).toEqual([...allowed].sort());
    });
  });

  /**
   * Reviewed, Phase 10. The rotation service reads every encrypted model by
   * design — re-encrypting is decrypt-then-encrypt, and a rotation that could
   * only reach one model would leave the others on a key about to be retired.
   *
   * What keeps it from being a hole: it has no route and no scheduled job, it
   * runs only from `npm run rotate-keys`, and the plaintext it produces goes
   * straight back into `cipher.encrypt` in the next statement — it is never
   * returned, logged or stored.
   */
  const ROTATION = 'src/core/crypto/rotation/key-rotation.service.ts';

  it('only the per-model readers and the rotation decrypt', () => {
    const readers = files
      .filter((f) => /ciphertext:\s*true/.test(f.source))
      .map((f) => f.path);
    expect(readers.sort()).toEqual([...Object.keys(CIPHERTEXT_READERS), ROTATION].sort());
  });

  it('the rotation never returns, logs or stores the plaintext it decrypts', () => {
    const source = files.find((f) => f.path === ROTATION)!.source;

    // It decrypts into a local that is immediately re-encrypted.
    expect(source).toMatch(/const plaintext = await this\.cipher\.decrypt/);
    expect(source).toMatch(/await this\.cipher\.encrypt\(plaintext\)/);
    // And nothing else is done with it.
    expect(source).not.toMatch(/(logger|console)\.[a-z]+\([^)]*plaintext/);
    expect(source).not.toMatch(/return[^;]*plaintext/);
  });

  it.each(Object.entries(CIPHERTEXT_READERS))(
    '%s reads only its own model',
    (path, ownModel) => {
      const source = files.find((f) => f.path === path)!.source;
      const others = Object.values(CIPHERTEXT_READERS).filter((m) => m !== ownModel);
      for (const other of others) {
        expect(new RegExp(`\\.${other}\\.`).test(source)).toBe(false);
      }
    },
  );

  it('the profile repository writes ciphertext through a nested relation only', () => {
    const profile = files.find(
      (f) => f.path === 'src/profile/prisma-profile.repository.ts',
    )!;
    // It never touches the model directly — writes go through
    // `sensitive: { create | upsert }` on ProfileField, which is why it does
    // not appear in the allowlist above.
    expect(profile.source).not.toMatch(/\.sensitiveValue\./);
    // It passes envelope fields into `data`, which is a write. The value goes
    // through toBytes() on the way — Prisma's Bytes type, not a reshaping of
    // the ciphertext — so the assertion allows that wrapper and nothing else.
    expect(profile.source).toMatch(/ciphertext:\s*(?:toBytes\()?e\.ciphertext/);
    // ...and never asks for the column back.
    expect(profile.source).not.toMatch(/ciphertext:\s*true/);
  });

  it('the sensitive relation is only ever written, never selected with its value', () => {
    // `sensitive: { select: { id: true } }` proves a value exists without
    // loading it. Selecting the relation without a narrowing select would pull
    // the ciphertext into memory for every list call.
    for (const f of files) {
      const bare = /sensitive:\s*true/.test(f.source);
      expect(bare ? f.path : null).toBeNull();
    }
  });

  it('the disclosure repository logs in the same transaction as it decrypts', () => {
    const disclosure = files.find(
      (f) => f.path === 'src/disclosure/prisma-sensitive-value.repository.ts',
    )!;
    const reveal = disclosure.source.slice(disclosure.source.indexOf('async reveal'));
    const auditAt = reveal.indexOf('audit.record');
    const decryptAt = reveal.indexOf('cipher.decrypt');

    expect(reveal).toMatch(/\$transaction/);
    expect(auditAt).toBeGreaterThan(-1);
    expect(decryptAt).toBeGreaterThan(-1);
    // The audit write must come first: if it fails, the transaction rolls back
    // and the caller never receives a plaintext value.
    expect(auditAt).toBeLessThan(decryptAt);
  });

  it('only the profile controller can reveal a SENSITIVE PROFILE FIELD', () => {
    // The vault has its own reveal, for credentials — a different secret with
    // its own gate. What must not exist is a second way to reach a sensitive
    // profile value, so this looks for the service call rather than the word.
    const callers = files
      .filter((f) => /sensitiveReader|revealField\s*\(/.test(f.source))
      .map((f) => f.path)
      .filter((p) => p !== 'src/profile/profile.service.ts');
    expect(callers).toEqual(['src/profile/profile.controller.ts']);
  });

  it('no VA-facing controller can reach a sensitive profile field at all', () => {
    const vaControllers = files.filter(
      (f) => f.path.endsWith('.controller.ts') && /@Roles\('VA'\)/.test(f.source),
    );
    // There is at least one, or this passes vacuously.
    expect(vaControllers.length).toBeGreaterThan(0);
    for (const f of vaControllers) {
      expect(f.source).not.toMatch(/sensitive|ProfileService|revealField/i);
    }
  });
});
