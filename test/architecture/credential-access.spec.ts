import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * The Phase 3 acceptance criterion, as a test:
 *
 *   "ICredentialRepository as provided to VA-reachable code exposes no method
 *    returning more than one record — verified by an architecture test, not a
 *    convention."
 *
 * Three things have to hold, and each can break independently:
 *
 *   1. The VA-facing interface has exactly one method, returning one record.
 *   2. Only the vault repository touches the Credential or ProviderKey models.
 *   3. No controller injects a writer or key repository token directly — routes
 *      go through the service that applies the §7.4 gate.
 */

const VAULT_REPOSITORY = 'src/vault/prisma-credential.repository.ts';
const KEY_REPOSITORY = 'src/keyring/prisma-provider-key.repository.ts';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.ts$/.test(entry) && !/\.spec\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

describe('credential access', () => {
  const root = join(__dirname, '../..');
  const files = walk(join(root, 'src')).map((f) => ({
    path: relative(root, f).replace(/\\/g, '/'),
    source: readFileSync(f, 'utf8'),
  }));
  const find = (p: string) => files.find((f) => f.path === p)!;

  it('finds source to check', () => {
    expect(files.length).toBeGreaterThan(30);
  });

  describe('the VA-facing interface', () => {
    const contract = () => {
      const src = find('src/vault/credential.repository.ts').source;
      const start = src.indexOf('export interface ICredentialRevealer');
      // Brace-balanced: the method's parameter is itself an object literal, so
      // stopping at the first closing brace would cut the return type off and
      // make this test pass for the wrong reason.
      let depth = 0;
      for (let i = src.indexOf('{', start); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
      }
      throw new Error('ICredentialRevealer declaration not found');
    };

    it('exposes exactly one method', () => {
      // Counts `name(` declarations inside the interface body.
      const methods = contract().match(/^\s{2}\w+\s*\(/gm) ?? [];
      expect(methods).toHaveLength(1);
    });

    it('returns a single record or nothing — never an array', () => {
      const body = contract();
      expect(body).toMatch(/Promise<RevealedCredential \| null>/);
      expect(body).not.toMatch(/\[\]/);
      // Comments are stripped first — 'null' and 'all' appear in prose above.
      const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
      expect(code).not.toMatch(/findMany|listAll|\blist\b/i);
    });

    it('takes one site id, not a collection', () => {
      expect(contract()).toMatch(/siteId:\s*string/);
      expect(contract()).not.toMatch(/siteIds/);
    });
  });

  describe('model access', () => {
    it('only the vault repository queries Credential', () => {
      const callers = files
        .filter((f) => /\.credential\.(?!repository)/.test(f.source))
        .map((f) => f.path);
      expect(callers).toEqual([VAULT_REPOSITORY]);
    });

    it('only the keyring repository queries ProviderKey', () => {
      const callers = files
        .filter((f) => /\.providerKey\./.test(f.source))
        .map((f) => f.path);
      expect(callers).toEqual([KEY_REPOSITORY]);
    });

    it('only the vault repository and the key rotation select credential ciphertext', () => {
      // The rotation is reviewed in sensitive-reads.spec.ts: no route, no job,
      // and the plaintext goes straight back into encrypt().
      const ROTATION = 'src/core/crypto/rotation/key-rotation.service.ts';
      const readers = files
        .filter((f) => /ciphertext:\s*true/.test(f.source))
        .map((f) => f.path)
        .filter((p) => p !== 'src/disclosure/prisma-sensitive-value.repository.ts');
      expect(readers.sort()).toEqual([KEY_REPOSITORY, VAULT_REPOSITORY, ROTATION].sort());
    });
  });

  describe('routes', () => {
    const controllers = files.filter((f) => f.path.endsWith('.controller.ts'));

    it('no controller injects a credential repository token', () => {
      const offenders = controllers
        .filter((f) => /CREDENTIAL_WRITER|CREDENTIAL_REVEALER/.test(f.source))
        .map((f) => f.path);
      // Routes go through VaultService, which is where the §7.4 gate lives.
      // Injecting the repository would route around the gate entirely.
      expect(offenders).toEqual([]);
    });

    it('the VA controller reaches only the service', () => {
      const va = find('src/vault/va-vault.controller.ts').source;
      expect(va).toMatch(/private readonly vault: VaultService/);
      expect(va).not.toMatch(/Repository/);
    });

    it('no route returns a provider key', () => {
      const offenders = controllers
        .filter((f) => /PROVIDER_KEY_REPOSITORY/.test(f.source))
        .filter((f) => /\.read\s*\(/.test(f.source))
        .map((f) => f.path);
      // The keyring controller may write and report status; `read` decrypts,
      // and no HTTP route may call it.
      expect(offenders).toEqual([]);
    });
  });

  describe('the reveal transaction', () => {
    it('logs before it decrypts, inside one transaction', () => {
      const src = find(VAULT_REPOSITORY).source;
      const reveal = src.slice(src.indexOf('async revealForSite'));
      const auditAt = reveal.indexOf('audit.record');
      const decryptAt = reveal.indexOf('cipher.decrypt');

      expect(reveal).toMatch(/\$transaction/);
      expect(auditAt).toBeGreaterThan(-1);
      // If the audit write throws, the transaction rolls back and no password
      // was produced — so an unlogged reveal cannot happen.
      expect(auditAt).toBeLessThan(decryptAt);
    });
  });
});
