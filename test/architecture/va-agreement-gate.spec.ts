import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * THE SWEEP.
 *
 * PRD Phase 5 acceptance: "Every VA route except the three permitted returns
 * 403 until signing completes — asserted by an automated sweep over the VA
 * route table, so a route added later without the guard fails CI."
 *
 * AgreementGuard is global and default-deny, so a new VA route is gated
 * automatically. What this catches is the other direction: somebody adding a
 * fourth @AgreementExempt(), which is the only way past.
 */
const PERMITTED_BEFORE_SIGNING = new Set([
  // You cannot sign without an account.
  'VaOnboardingController.acceptInvite',
  // You cannot sign text you have not been shown.
  'VaOnboardingController.agreement',
  // You cannot sign without submitting a signature.
  'VaOnboardingController.sign',
]);

const HTTP_METHOD = /@(Get|Post|Put|Patch|Delete|Head|Options)\s*\(/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.controller\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

interface Route {
  id: string;
  vaReachable: boolean;
  exempt: boolean;
  isPublic: boolean;
}

function parse(source: string, controller: string): Route[] {
  const controllerAt = source.search(/@Controller\s*\(/);
  const header = controllerAt === -1 ? '' : source.slice(controllerAt);
  const headerEnd = header.search(/^export class /m);
  const classDecorators = headerEnd === -1 ? '' : header.slice(0, headerEnd);

  const classVa = /@Roles\([^)]*'VA'[^)]*\)/.test(classDecorators);
  const classExempt = /@AgreementExempt\s*\(/.test(classDecorators);
  const classPublic = /@Public\s*\(/.test(classDecorators);

  const lines = source.split('\n');
  const routes: Route[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (!HTTP_METHOD.test(lines[i])) continue;

    let vaReachable = classVa;
    let exempt = classExempt;
    let isPublic = classPublic;
    for (let j = i; j >= 0 && (lines[j].trim().startsWith('@') || !lines[j].trim()); j--) {
      if (/@Roles\([^)]*'VA'/.test(lines[j])) vaReachable = true;
      if (/@AgreementExempt\s*\(/.test(lines[j])) exempt = true;
      if (/@Public\s*\(/.test(lines[j])) isPublic = true;
    }

    let name = '';
    for (let j = i + 1; j < lines.length; j++) {
      const m = lines[j].match(/^\s*(?:async\s+)?(\w+)\s*\(/);
      if (m && !lines[j].trim().startsWith('@')) {
        name = m[1];
        break;
      }
    }
    if (name) routes.push({ id: `${controller}.${name}`, vaReachable, exempt, isPublic });
  }
  return routes;
}

describe('VA agreement gate', () => {
  const root = join(__dirname, '../..');
  const routes = walk(join(root, 'src')).flatMap((file) => {
    const base = relative(root, file).split(/[\\/]/).pop()!.replace('.controller.ts', '');
    const className =
      base
        .split('-')
        .map((p) => p[0].toUpperCase() + p.slice(1))
        .join('') + 'Controller';
    return parse(readFileSync(file, 'utf8'), className);
  });

  const vaRoutes = routes.filter((r) => r.vaReachable || r.isPublic);

  it('finds VA-reachable routes to check', () => {
    expect(routes.filter((r) => r.vaReachable).length).toBeGreaterThan(2);
  });

  it('the set of routes reachable before signing is exactly the reviewed list', () => {
    const permitted = vaRoutes
      .filter((r) => r.exempt || (r.isPublic && r.id.startsWith('VaOnboarding')))
      .map((r) => r.id)
      .sort();
    expect(permitted).toEqual([...PERMITTED_BEFORE_SIGNING].sort());
  });

  it('no VA route outside that list is exempt', () => {
    const unexpected = routes
      .filter((r) => r.exempt && !PERMITTED_BEFORE_SIGNING.has(r.id))
      .map((r) => r.id);
    expect(unexpected).toEqual([]);
  });

  it('every permitted route still exists', () => {
    const ids = routes.map((r) => r.id);
    for (const permitted of PERMITTED_BEFORE_SIGNING) expect(ids).toContain(permitted);
  });

  it('the guard is registered globally, not per controller', () => {
    // Per-controller registration is how a new controller ships ungated.
    const module = readFileSync(join(root, 'src/identity/va/va.module.ts'), 'utf8');
    expect(module).toMatch(/APP_GUARD[\s\S]*AgreementGuard/);
  });

  it('the guard checks revocation as well as the signature', () => {
    // Same row, same query — and it is what makes revocation take effect within
    // one request cycle rather than at token expiry.
    const guard = readFileSync(
      join(root, 'src/identity/va/guards/agreement.guard.ts'),
      'utf8',
    );
    expect(guard).toMatch(/state\.revokedAt/);
    expect(guard).toMatch(/hasSignedAgreement/);
  });

  it('exemption is only available through the decorator', () => {
    const guard = readFileSync(
      join(root, 'src/identity/va/guards/agreement.guard.ts'),
      'utf8',
    );
    // No env flag, no config toggle, no "skip in development".
    expect(guard).not.toMatch(/process\.env|isDevelopment|NODE_ENV/);
  });
});
