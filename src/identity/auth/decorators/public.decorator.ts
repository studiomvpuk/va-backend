import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'auth:public';

/**
 * Opts a route out of authentication.
 *
 * Guards are default-deny and applied globally, so this decorator is the ONLY
 * way a route becomes reachable without a token. That makes every unauthenticated
 * endpoint in the codebase greppable in one command, which is the point — the
 * architecture test asserts the list matches an expected allowlist, so adding a
 * public route is a deliberate, reviewable act.
 */
export const Public = () => SetMetadata(IS_PUBLIC, true);
