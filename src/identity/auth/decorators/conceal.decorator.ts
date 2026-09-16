import { SetMetadata } from '@nestjs/common';

export const CONCEAL_FROM_OTHER_ROLES = 'auth:conceal';

/**
 * Makes a wrong-role request 404 instead of 403.
 *
 * PRD Phase 8 acceptance: "A VA token on any prep-doc path returns 404, not
 * 403 — the resource's existence is not disclosed."
 *
 * 403 is an answer. It tells the caller the path is real, the id is real, and
 * the only thing missing is permission — which for a prep document means a VA
 * can enumerate application ids and learn which of their Client's applications
 * reached an interview. That is information about the Client's job search that
 * the VA was never given, and no route returns it deliberately.
 *
 * Not the default for every route, because concealment costs something: a
 * Client who hits a Client-only route with a VA token gets a confusing 404
 * instead of a clear "wrong account". This is for resources where the existence
 * itself is the secret, and each one says so out loud.
 */
export const ConcealFromOtherRoles = () => SetMetadata(CONCEAL_FROM_OTHER_ROLES, true);
