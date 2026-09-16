import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC } from '../decorators/public.decorator';
import { REQUIRED_ROLES } from '../decorators/roles.decorator';
import { CONCEAL_FROM_OTHER_ROLES } from '../decorators/conceal.decorator';
import type { AccessTokenClaims, AuthRole } from '../auth.types';

/**
 * Enforces @Roles().
 *
 * A Client token on a VA route and a VA token on a Client route are both 403.
 * This is the second of the two mechanisms that keep the VA surface small: the
 * route table decides what exists, and this decides who may reach it.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const required = this.reflector.getAllAndOverride<AuthRole[] | undefined>(
      REQUIRED_ROLES,
      [context.getHandler(), context.getClass()],
    );

    // No declaration means nobody thought about it. Refuse rather than allow
    // both roles by default — the architecture test also catches this, but a
    // route that slips through should fail closed at runtime.
    if (!required || required.length === 0) {
      throw new ForbiddenException('Route does not declare its permitted roles');
    }

    const user = context
      .switchToHttp()
      .getRequest<{ user?: AccessTokenClaims }>().user;

    if (!user || !required.includes(user.role)) {
      // Some resources must not confirm their own existence to the wrong role
      // — see @ConcealFromOtherRoles. The 404 is indistinguishable from the one
      // an unknown id would produce, which is the entire point.
      const conceal = this.reflector.getAllAndOverride<boolean>(
        CONCEAL_FROM_OTHER_ROLES,
        [context.getHandler(), context.getClass()],
      );
      if (conceal) throw new NotFoundException();

      throw new ForbiddenException('Insufficient role for this route');
    }
    return true;
  }
}
