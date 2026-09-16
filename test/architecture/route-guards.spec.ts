import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Default-deny, enforced at build time.
 *
 * Guards are global, so a new route is authenticated automatically. The failure
 * mode this catches is the opposite one: a route that is authenticated but
 * declares no @Roles(), which RolesGuard refuses at runtime — better to find it
 * in CI than in production.
 *
 * It also pins the set of @Public() routes. Every unauthenticated endpoint in
 * the product is listed here, so making one public is a visible, reviewable act
 * rather than a decorator somebody added on a Friday.
 */
const EXPECTED_PUBLIC = new Set([
  'AuthController.register',
  'AuthController.login',
  'AuthController.vaLogin',
  'AuthController.refresh',
  'AuthController.logout',
  'HealthController.check',
  // Reviewed, Phase 5: an invited assistant has no account yet, so there is no
  // token they could present. The invite token IS the credential, and it is
  // single-use, expiring and hashed at rest.
  'VaOnboardingController.acceptInvite',
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
  isPublic: boolean;
  hasRoles: boolean;
}

function parseRoutes(source: string, controller: string): Route[] {
  const routes: Route[] = [];
  const lines = source.split('\n');

  /*
   * @Roles() and @Public() are valid on the CLASS as well as the method —
   * RolesGuard resolves them with getAllAndOverride, which checks both. A
   * controller where every route is Client-only declares it once at the top,
   * and that is the better style, so this parser has to understand it.
   */
  // Anchor on the @Controller decorator, not the first `export class` in the
  // file — a controller that declares DTOs above itself would otherwise have
  // its class-level decorators missed entirely, which is how this test once
  // reported a correctly-guarded route as undeclared.
  const controllerAt = source.search(/@Controller\s*\(/);
  const classHeader = controllerAt === -1 ? '' : source.slice(controllerAt);
  const headerEnd = classHeader.search(/^export class /m);
  const decorators = headerEnd === -1 ? '' : classHeader.slice(0, headerEnd);
  const classRoles = /@Roles\s*\(/.test(decorators);
  const classPublic = /@Public\s*\(/.test(decorators);

  for (let i = 0; i < lines.length; i++) {
    if (!HTTP_METHOD.test(lines[i])) continue;

    // Walk backwards over the decorator block to see what this route declares,
    // and forwards to find the method name.
    let isPublic = classPublic;
    let hasRoles = classRoles;
    for (let j = i; j >= 0 && (lines[j].trim().startsWith('@') || lines[j].trim() === ''); j--) {
      if (/@Public\s*\(/.test(lines[j])) isPublic = true;
      if (/@Roles\s*\(/.test(lines[j])) hasRoles = true;
    }

    let name = '';
    for (let j = i + 1; j < lines.length; j++) {
      const m = lines[j].match(/^\s*(?:async\s+)?(\w+)\s*\(/);
      if (m && !lines[j].trim().startsWith('@')) {
        name = m[1];
        break;
      }
    }
    if (name) routes.push({ id: `${controller}.${name}`, isPublic, hasRoles });
  }
  return routes;
}

describe('route guard declarations', () => {
  const root = join(__dirname, '../..');
  const controllers = walk(join(root, 'src'));

  const routes = controllers.flatMap((file) => {
    const name = relative(root, file)
      .split(/[\\/]/)
      .pop()!
      .replace('.controller.ts', '');
    const className = name
      .split('-')
      .map((p) => p[0].toUpperCase() + p.slice(1))
      .join('') + 'Controller';
    return parseRoutes(readFileSync(file, 'utf8'), className);
  });

  it('finds routes to check', () => {
    expect(routes.length).toBeGreaterThan(3);
  });

  it('every authenticated route declares the roles that may reach it', () => {
    const undeclared = routes.filter((r) => !r.isPublic && !r.hasRoles).map((r) => r.id);
    expect(undeclared).toEqual([]);
  });

  it('the set of public routes is exactly the reviewed allowlist', () => {
    const actual = routes.filter((r) => r.isPublic).map((r) => r.id).sort();
    expect(actual).toEqual([...EXPECTED_PUBLIC].sort());
  });

  it('no route is both public and role-restricted — that combination is a mistake', () => {
    const both = routes.filter((r) => r.isPublic && r.hasRoles).map((r) => r.id);
    expect(both).toEqual([]);
  });
});
