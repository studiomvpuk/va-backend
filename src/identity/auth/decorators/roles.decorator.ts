import { SetMetadata } from '@nestjs/common';
import type { AuthRole } from '../auth.types';

export const REQUIRED_ROLES = 'auth:roles';

/**
 * Restricts a route to specific roles.
 *
 * A route with no @Roles() is reachable by both CLIENT and VA. That is rarely
 * what anyone means, so RolesGuard requires an explicit declaration and the
 * architecture test fails any authenticated controller route missing one.
 */
export const Roles = (...roles: AuthRole[]) => SetMetadata(REQUIRED_ROLES, roles);
