import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Guards the type-level counterpart to the tenant extension's create-stamping.
 *
 * `stampedByTenant()` tells the compiler that `clientId` will be supplied at
 * runtime by `tenantScopedExtension`. That is true — and only true — for a
 * create issued through the extended Prisma client. Used anywhere else it is a
 * plain lie to the type system, and it would be an easy one to reach for the
 * next time a create input will not typecheck.
 *
 * So it is confined to the persistence layer, the same way `runUnscoped` is
 * confined to auth bootstrapping, and by the same mechanism: adding a call site
 * means editing this file, which means a reviewer sees it.
 *
 * If this test is failing because you added a call, the question is not "how do
 * I add it to the list" but "is this a Prisma create on the tenant-scoped
 * client?" If it is not, the cast is wrong and the missing `clientId` is real.
 */
const PERMITTED = [
  // Repositories: the persistence layer, which is what this helper is for.
  /^src\/[a-z-]+\/prisma-[a-z-]+\.repository\.ts$/,
  /^src\/[a-z-]+\/[a-z-]+\/prisma-[a-z-]+\.repository\.ts$/,
];

const ALSO_ALLOWED = new Set([
  'src/core/tenancy/tenant-stamped.ts', // where it is defined
  // Reviewed: the audit logger writes AuditEvent directly rather than through a
  // repository, because it has to be able to join a caller's transaction.
  'src/core/audit/audit.service.ts',
]);

/**
 * Comments explain the hole; they are not the hole. Matching against them is
 * how a test like this passes or fails on its own prose instead of the code.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.ts$/.test(entry) && !/\.spec\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

describe('stampedByTenant call sites', () => {
  const root = join(__dirname, '../..');
  const files = walk(join(root, 'src'));

  const callers = files
    .filter((f) => /\bstampedByTenant(Many)?\s*[(<]/.test(readFileSync(f, 'utf8')))
    .map((f) => relative(root, f).replace(/\\/g, '/'));

  it('finds the definition (guards against a broken matcher passing vacuously)', () => {
    expect(callers).toContain('src/core/tenancy/tenant-stamped.ts');
  });

  it('is used only from the persistence layer', () => {
    const unexpected = callers.filter(
      (c) => !ALSO_ALLOWED.has(c) && !PERMITTED.some((p) => p.test(c)),
    );
    expect(unexpected).toEqual([]);
  });

  it('never widens to any — the other fields stay checked', () => {
    const source = code(
      readFileSync(join(root, 'src/core/tenancy/tenant-stamped.ts'), 'utf8'),
    );
    // The whole value of this helper over a bare cast is that every field
    // except clientId is still checked against the generated input type. An
    // `any` anywhere in here would quietly give that up.
    expect(source).not.toMatch(/\bany\b/);
    expect(source).toMatch(/Omit<TCreateInput, 'clientId'>/);
  });

  it('stays type-level — the runtime guard belongs to the extension', () => {
    const source = code(
      readFileSync(join(root, 'src/core/tenancy/tenant-stamped.ts'), 'utf8'),
    );
    // A second runtime check here could only ever disagree with the extension's
    // MissingTenantContextError, which is the one that actually stops the write.
    expect(source).not.toMatch(/\bthrow\b/);
  });
});
