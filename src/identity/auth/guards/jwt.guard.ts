import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { TokenService } from '../token.service';
import { IS_PUBLIC } from '../decorators/public.decorator';
import type { AccessTokenClaims } from '../auth.types';

/**
 * Verifies the bearer token and attaches its claims to the request.
 *
 * Applied globally and default-deny: a route is unauthenticated only if it
 * carries @Public().
 *
 * The access token travels in the Authorization header, not a cookie. That is
 * what lets the API skip CSRF protection entirely — a cross-site request cannot
 * set an Authorization header, and the browser will not attach one on its own.
 * Only the refresh token uses a cookie, scoped to the refresh path alone.
 */
@Injectable()
export class JwtGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request & { user?: AccessTokenClaims }>();
    const header = req.headers.authorization;

    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }

    req.user = await this.tokens.verifyAccessToken(header.slice(7));
    return true;
  }
}
