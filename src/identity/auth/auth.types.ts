import type { ActorType } from '../../core/tenancy/tenant.context';

export type AuthRole = Extract<ActorType, 'CLIENT' | 'VA'>;

/**
 * The verified access-token claims.
 *
 * `clientId` is the tenant. For a Client it equals `sub`; for a VA it is the
 * Client who invited them. This single claim is what confines a VA to exactly
 * one Client's data, and it is the ONLY source TenantGuard will accept — never
 * a header, query parameter or body field.
 */
export interface AccessTokenClaims {
  sub: string;
  role: AuthRole;
  clientId: string;
  email: string;
}

export interface TokenPair {
  accessToken: string;
  /** Returned to the transport layer to be set as an httpOnly cookie. */
  refreshToken: string;
  refreshExpiresAt: Date;
}

export interface RequestMeta {
  ipAddress?: string;
  userAgent?: string;
}
