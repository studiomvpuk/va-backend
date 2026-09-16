import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC } from '../../auth/decorators/public.decorator';
import { AGREEMENT_EXEMPT } from '../decorators/agreement-exempt.decorator';
import { VA_REPOSITORY, type IVaRepository } from '../va.repository';
import type { AccessTokenClaims } from '../../auth/auth.types';

/**
 * The agreement gate (PRD §5.7).
 *
 * "Access to sensitive fields, credentials, or the chat itself is gated on this
 * being complete."
 *
 * Applies to VA requests only. A Client token passes straight through — they do
 * not sign anything, they are the one being protected.
 *
 * ── Two jobs, one query ──────────────────────────────────────────────────────
 * This guard also enforces revocation, and that is not scope creep: it already
 * has to read the VA's row to check the agreement, and `revokedAt` is a column
 * on that same row. Checking it here is free, and it is what makes revocation
 * take effect "within one request cycle, not at next expiry" — a JWT cannot be
 * un-issued, so something has to look.
 *
 * The cost is one indexed primary-key lookup per VA request. At this scale that
 * is the right trade against the alternative, which is a revoked assistant
 * keeping access for up to fifteen minutes.
 */
@Injectable()
export class AgreementGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(VA_REPOSITORY) private readonly vas: IVaRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const user = context.switchToHttp().getRequest<{ user?: AccessTokenClaims }>().user;
    // No claims means an earlier guard already refused, or will.
    if (!user || user.role !== 'VA') return true;

    const state = await this.vas.accessState(user.sub);
    if (!state) throw new ForbiddenException('This account no longer exists');

    if (state.revokedAt) {
      throw new ForbiddenException(
        'Your access to this account has been withdrawn. Your obligations under ' +
          'the agreement you signed still apply.',
      );
    }

    const exempt = this.reflector.getAllAndOverride<boolean>(AGREEMENT_EXEMPT, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (exempt) return true;

    if (!state.hasSignedAgreement) {
      throw new ForbiddenException(
        'Read and sign the confidentiality agreement before continuing.',
      );
    }
    return true;
  }
}
