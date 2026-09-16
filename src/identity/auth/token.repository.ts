import type { SubjectType } from './refresh-token.model';

export interface StoredRefreshToken {
  id: string;
  tokenHash: string;
  familyId: string;
  subjectType: SubjectType;
  subjectId: string;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
}

export interface NewRefreshToken {
  tokenHash: string;
  familyId: string;
  subjectType: SubjectType;
  subjectId: string;
  expiresAt: Date;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Refresh-token persistence.
 *
 * Deliberately narrow. There is no "find all tokens" method, and lookup is by
 * hash only — the caller must already hold the token to find its record.
 */
export interface IRefreshTokenRepository {
  create(token: NewRefreshToken): Promise<StoredRefreshToken>;
  findByHash(tokenHash: string): Promise<StoredRefreshToken | null>;
  markUsed(id: string): Promise<void>;
  /** Reuse detection: kill every token descended from the same login. */
  revokeFamily(familyId: string): Promise<number>;
  revokeAllForSubject(subjectType: SubjectType, subjectId: string): Promise<number>;
  deleteExpired(now: Date): Promise<number>;
}

export const REFRESH_TOKEN_REPOSITORY = Symbol('REFRESH_TOKEN_REPOSITORY');
