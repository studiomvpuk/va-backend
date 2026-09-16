import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENCRYPTED_TABLES } from '../../src/core/crypto/rotation/key-rotation.service';

/**
 * Every table holding a CipherEnvelope is in the rotation's list.
 *
 * ── The failure this prevents ───────────────────────────────────────────────
 * A new table with a `ciphertext` column, not added to ENCRYPTED_TABLES, is
 * skipped silently by every rotation. Its rows stay on the retiring key, the
 * rotation reports "nothing remains on a previous key", the operator removes
 * the old key as instructed — and those records become permanently unreadable.
 *
 * Nothing at runtime would say so, because the rotation cannot miss what it
 * does not know to look for. So the schema is the source of truth and this
 * checks the list against it.
 */
const SCHEMA = readFileSync(join(__dirname, '../../prisma/schema.prisma'), 'utf8');

/** Prisma model name → the client's property name. */
function toClientKey(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

describe('encrypted tables', () => {
  const encryptedModels = [...SCHEMA.matchAll(/model (\w+) \{([\s\S]*?)\n\}/g)]
    .filter(([, , body]) => /^\s*ciphertext\s+Bytes/m.test(body))
    .map(([, name]) => name);

  it('finds the models that store ciphertext', () => {
    expect(encryptedModels.length).toBeGreaterThanOrEqual(3);
  });

  it('every one of them is in the rotation list', () => {
    const missing = encryptedModels
      .map(toClientKey)
      .filter((key) => !ENCRYPTED_TABLES.includes(key as never));

    // Each name here needs adding to ENCRYPTED_TABLES in key-rotation.service.ts.
    expect({ notRotated: missing }).toEqual({ notRotated: [] });
  });

  it('the rotation list has nothing that is not a table', () => {
    const known = new Set(encryptedModels.map(toClientKey));
    expect(ENCRYPTED_TABLES.filter((t) => !known.has(t))).toEqual([]);
  });

  it('every encrypted model carries the fields the rotation reads', () => {
    for (const model of encryptedModels) {
      const body = SCHEMA.match(new RegExp(`model ${model} \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '';
      // Re-encrypting needs all four: without keyVersion there is no way to
      // know which key opened the row, and no way to select stale ones.
      for (const field of ['ciphertext', 'iv', 'authTag', 'keyVersion']) {
        expect(`${model}.${field}: ${new RegExp(`^\\s*${field}\\s`, 'm').test(body)}`).toBe(
          `${model}.${field}: true`,
        );
      }
    }
  });
});
