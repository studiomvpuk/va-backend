import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * PRD Phase 8 acceptance: "A VA token on any prep-doc path returns 404, not
 * 403 — the resource's existence is not disclosed."
 *
 * ── Why this needs a test rather than a code review ─────────────────────────
 * 403 is the natural thing for a framework to return and the natural thing for
 * a developer to leave in place. It is also an answer: it confirms the path is
 * real, the id is real, and the only thing missing is permission. A VA who can
 * enumerate their Client's application ids and learn which ones reached an
 * interview has learned something about that Client's job search that no route
 * offers them deliberately.
 *
 * The assertions below are deliberately about the SOURCE rather than about a
 * live request. A runtime test proves the route behaves today; these prove the
 * guarantee cannot be removed by deleting one decorator, because deleting it
 * fails CI.
 */
const SRC = join(__dirname, '../../src');

const PREP_CONTROLLER = join(SRC, 'prep/prep.controller.ts');
const ROLES_GUARD = join(SRC, 'identity/auth/guards/roles.guard.ts');
const CONCEAL_DECORATOR = join(SRC, 'identity/auth/decorators/conceal.decorator.ts');

describe('prep documents are concealed, not merely refused', () => {
  const controller = readFileSync(PREP_CONTROLLER, 'utf8');
  const guard = readFileSync(ROLES_GUARD, 'utf8');

  it('the prep controller is Client-only', () => {
    expect(controller).toMatch(/@Roles\('CLIENT'\)/);
    expect(controller).not.toMatch(/'VA'/);
  });

  it('the prep controller conceals itself from other roles', () => {
    // At the class level, so it covers routes added later too — the decision is
    // about the resource, not about one endpoint.
    expect(controller).toMatch(/@ConcealFromOtherRoles\(\)/);
  });

  it('the guard turns concealment into 404, not 403', () => {
    expect(readFileSync(CONCEAL_DECORATOR, 'utf8')).toContain('CONCEAL_FROM_OTHER_ROLES');
    expect(guard).toContain('CONCEAL_FROM_OTHER_ROLES');
    expect(guard).toMatch(/if \(conceal\) throw new NotFoundException\(\)/);
  });

  it('the concealed 404 carries no message that would distinguish it', () => {
    // `new NotFoundException()` with no argument produces the same body as any
    // other unmatched resource. A message like "prep documents are Client-only"
    // would give away exactly what the 404 exists to hide.
    expect(guard).not.toMatch(/NotFoundException\(['"`]/);
  });

  it('no VA-reachable route resolves a PrepDocument', () => {
    // The model itself, not just the controller: a VA route that happened to
    // select a prep document through a relation would leak it just as well.
    const vaControllers = [
      'conversation/va-chat.controller.ts',
      'vault/va-vault.controller.ts',
      'identity/va/va-onboarding.controller.ts',
    ]
      .map((p) => join(SRC, p))
      .filter(exists);

    expect(vaControllers.length).toBeGreaterThan(0);
    for (const path of vaControllers) {
      expect(readFileSync(path, 'utf8')).not.toMatch(/prepDocument|PrepDocument|prepDoc/);
    }
  });
});

function exists(path: string): boolean {
  try {
    readFileSync(path, 'utf8');
    return true;
  } catch {
    return false;
  }
}
