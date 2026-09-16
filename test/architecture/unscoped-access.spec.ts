import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Guards the one hole in tenant isolation.
 *
 * runUnscoped() suspends tenant scoping. There is exactly one legitimate reason
 * for it — authentication must find an account before it can know the account's
 * tenant — and the allowlist below is the complete set of places that may do it.
 *
 * Adding a call site means editing this list, which means a reviewer sees it.
 * That is the entire mechanism. If this test is failing because you added a
 * call, the question to answer is not "how do I add it to the list" but "why
 * does this code need to read across tenants at all" — for anything other than
 * an auth lookup, the answer is that it does not, and the route is wrong.
 */
const ALLOWED = new Set([
  'src/core/tenancy/tenant.context.ts', // where it is defined
  'src/identity/accounts/prisma-account.repository.ts', // VA lookup during login
  // Reviewed, Phase 5: accepting an invitation is the same bootstrapping
  // problem as logging in. The invite token is what identifies which Client the
  // assistant belongs to, so the lookup cannot be scoped by the thing it exists
  // to discover.
  'src/identity/va/prisma-va.repository.ts',
  // Reviewed, Phase 10: key rotation re-encrypts every tenant's stored secrets.
  // It is an operator task across all tenants by definition — there is no
  // Client whose context it could run in — and it is reachable only from
  // `npm run rotate-keys`, never from a route.
  'src/core/crypto/rotation/key-rotation.service.ts',
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.ts$/.test(entry) && !/\.spec\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

describe('runUnscoped call sites', () => {
  const root = join(__dirname, '../..');
  const files = walk(join(root, 'src'));

  const callers = files
    .filter((f) => /\brunUnscoped\s*\(/.test(readFileSync(f, 'utf8')))
    .map((f) => relative(root, f).replace(/\\/g, '/'));

  it('finds the definition (guards against a broken matcher passing vacuously)', () => {
    expect(callers).toContain('src/core/tenancy/tenant.context.ts');
  });

  it('has no call site outside the allowlist', () => {
    const unexpected = callers.filter((c) => !ALLOWED.has(c));
    expect(unexpected).toEqual([]);
  });

  it('keeps the allowlist minimal — every entry is still a real call site', () => {
    for (const allowed of ALLOWED) expect(callers).toContain(allowed);
  });
});
