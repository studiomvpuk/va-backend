import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { currentTenant } from './tenant.context';
import type { ActorType } from './tenant.context';
import { IS_PUBLIC } from '../../identity/auth/decorators/public.decorator';

interface AuthenticatedRequest {
  user?: { clientId?: string; sub?: string; role?: ActorType };
}

/**
 * Populates the tenant context opened by TenantContextMiddleware.
 *
 * Runs after the JWT guard. The clientId comes from the verified token claim —
 * never from a header, query parameter or request body, all of which the caller
 * controls. A VA's token carries the clientId of the Client who invited them,
 * which is what confines a VA to exactly one Client's data.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // A @Public() route has no claims and therefore no tenant. Queries it makes
    // on scoped models still throw, which is correct — a public route has no
    // business reading tenant data.
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const store = currentTenant();
    if (!store) {
      // The middleware is not wired up. This is a deployment error, not a
      // caller error, so it is a 500 rather than a 403.
      throw new InternalServerErrorException(
        'TenantContextMiddleware is not applied to this route',
      );
    }

    const user = context.switchToHttp().getRequest<AuthenticatedRequest>().user;
    if (!user?.clientId || !user.sub || !user.role) {
      throw new ForbiddenException('No tenant context on this request');
    }

    store.clientId = user.clientId;
    store.actorType = user.role;
    store.actorId = user.sub;
    return true;
  }
}
