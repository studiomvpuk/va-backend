import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { IS_PUBLIC } from '../decorators/public.decorator';
import { REQUIRED_ROLES } from '../decorators/roles.decorator';
import { CONCEAL_FROM_OTHER_ROLES } from '../decorators/conceal.decorator';

function context(user?: { role: string }): ExecutionContext {
  return {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

function reflector(metadata: Record<string, unknown>): Reflector {
  return {
    getAllAndOverride: (key: string) => metadata[key],
  } as unknown as Reflector;
}

describe('RolesGuard', () => {
  it('lets a matching role through', () => {
    const guard = new RolesGuard(reflector({ [REQUIRED_ROLES]: ['CLIENT'] }));
    expect(guard.canActivate(context({ role: 'CLIENT' }))).toBe(true);
  });

  it('lets a public route through with no user at all', () => {
    const guard = new RolesGuard(reflector({ [IS_PUBLIC]: true }));
    expect(guard.canActivate(context())).toBe(true);
  });

  it('refuses a route that declares no roles', () => {
    // No declaration means nobody thought about it. Fail closed.
    const guard = new RolesGuard(reflector({}));
    expect(() => guard.canActivate(context({ role: 'CLIENT' }))).toThrow(ForbiddenException);
  });

  it('403s the wrong role by default', () => {
    const guard = new RolesGuard(reflector({ [REQUIRED_ROLES]: ['CLIENT'] }));
    expect(() => guard.canActivate(context({ role: 'VA' }))).toThrow(ForbiddenException);
  });

  describe('concealment', () => {
    const guard = new RolesGuard(
      reflector({ [REQUIRED_ROLES]: ['CLIENT'], [CONCEAL_FROM_OTHER_ROLES]: true }),
    );

    it('404s the wrong role instead', () => {
      // 403 would confirm the path and the id are real, which for a prep
      // document tells a VA which of their Client's applications reached an
      // interview.
      expect(() => guard.canActivate(context({ role: 'VA' }))).toThrow(NotFoundException);
    });

    it('404s an unauthenticated request too', () => {
      expect(() => guard.canActivate(context())).toThrow(NotFoundException);
    });

    it('still lets the right role through', () => {
      expect(guard.canActivate(context({ role: 'CLIENT' }))).toBe(true);
    });

    it('produces a body indistinguishable from any other 404', () => {
      const thrown = (() => {
        try {
          guard.canActivate(context({ role: 'VA' }));
        } catch (e) {
          return e as NotFoundException;
        }
      })();

      // A message like "prep documents are Client-only" would give away exactly
      // what the 404 exists to hide.
      expect(thrown?.getResponse()).toEqual({
        message: 'Not Found',
        statusCode: 404,
      });
    });
  });
});
