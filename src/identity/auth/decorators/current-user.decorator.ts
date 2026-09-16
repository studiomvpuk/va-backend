import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AccessTokenClaims } from '../auth.types';

/** The verified claims for this request. Populated by JwtGuard. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AccessTokenClaims =>
    ctx.switchToHttp().getRequest<{ user: AccessTokenClaims }>().user,
);
