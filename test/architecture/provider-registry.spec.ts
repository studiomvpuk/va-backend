import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Keeps the open/closed claim true.
 *
 * PRD §2.4 says adding a provider touches nothing outside `ai/providers/`. That
 * held only after an experiment adding a third one showed it did not: the
 * registry was keyed by the keyring's billing enum, so a new implementation had
 * to widen a type in another module. These assertions pin the fix.
 */
const PROVIDERS_DIR = join(__dirname, '../../src/ai/providers');
const AI_MODULE = join(__dirname, '../../src/ai/ai.module.ts');

/**
 * ── Two kinds of provider now live here ─────────────────────────────────────
 * This suite originally assumed one: everything named `*.provider.ts` was a
 * model provider, belonged in REGISTRY, and had to pass the text-generator
 * contract. Phase 8 added search, which is none of those things — its key is
 * the operator's rather than the Client's, so it is bound once at boot in
 * ai.module.ts instead of being constructed per request from the registry.
 *
 * Rather than exempt the new files, the rule is restated: every provider is
 * reachable from exactly one of the two places, and which one decides what else
 * is required of it. An implementation in neither is dead code that looks
 * alive, which is the thing this file was written to catch.
 */
describe('provider registry', () => {
  const files = readdirSync(PROVIDERS_DIR).filter(
    (f) => f.endsWith('.provider.ts') && !f.endsWith('.spec.ts'),
  );
  const registry = readFileSync(join(PROVIDERS_DIR, 'registry.ts'), 'utf8');
  const aiModule = readFileSync(AI_MODULE, 'utf8');

  const classOf = (file: string) =>
    readFileSync(join(PROVIDERS_DIR, file), 'utf8').match(/export class (\w+)/)?.[1];

  const registered = files.filter((f) => registry.includes(classOf(f) ?? '\0'));
  const boundInModule = files.filter((f) => aiModule.includes(classOf(f) ?? '\0'));

  it('finds provider implementations', () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  it('every implementation is reachable from exactly one place', () => {
    for (const file of files) {
      const className = classOf(file);
      expect(className).toBeTruthy();

      const inRegistry = registered.includes(file);
      const inModule = boundInModule.includes(file);

      // Neither: dead code. Both: two construction paths for one provider, and
      // the one a caller gets then depends on which they happened to use.
      expect([inRegistry, inModule].filter(Boolean)).toHaveLength(1);
    }
  });

  it('every implementation has a spec', () => {
    const specs = readdirSync(PROVIDERS_DIR).filter((f) => f.endsWith('.provider.spec.ts'));
    for (const file of files) {
      expect(specs).toContain(file.replace('.provider.ts', '.provider.spec.ts'));
    }
  });

  it('every model provider runs at least the core contract', () => {
    // Only the registry ones. Substitutability is a claim about things a
    // caller receives as an ITextGenerator without knowing which — a search
    // provider is never one of those.
    for (const file of registered) {
      const source = readFileSync(
        join(PROVIDERS_DIR, file.replace('.provider.ts', '.provider.spec.ts')),
        'utf8',
      );
      // Either the full contract or the core half — but not neither.
      expect(source).toMatch(/describeTextGenerator(Core)?Contract/);
    }
  });

  it('the billing enum stays narrower than the registry', () => {
    const keyring = readFileSync(
      join(__dirname, '../../src/keyring/provider-key.repository.ts'),
      'utf8',
    );
    // Conflating these is what leaked the abstraction the first time: a local
    // stub needs no key and must not appear in billing.
    expect(keyring).toMatch(/export type Provider = 'ANTHROPIC' \| 'OPENAI';/);
    expect(registry).toMatch(/ProviderId = 'ANTHROPIC' \| 'OPENAI' \| 'ECHO'/);
  });

  it('no provider imports another provider', () => {
    // Providers are siblings, not a hierarchy. One importing another would make
    // "delete this file" stop being a safe operation.
    for (const file of files) {
      const source = readFileSync(join(PROVIDERS_DIR, file), 'utf8');
      const imports = source.match(/from '\.\/\w+\.provider'/g) ?? [];
      expect(imports).toEqual([]);
    }
  });
});
