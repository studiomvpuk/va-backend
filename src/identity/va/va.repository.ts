export interface VaSummary {
  id: string;
  email: string;
  fullName: string;
  createdAt: Date;
  revokedAt: Date | null;
  /** Has an unexpired invite that has not been accepted. */
  invitePending: boolean;
  agreement: {
    signedAt: Date;
    signedName: string;
    documentVersion: string;
    documentHash: string;
  } | null;
}

/** The minimum a per-request gate needs. One row, three columns. */
export interface VaAccessState {
  id: string;
  revokedAt: Date | null;
  hasSignedAgreement: boolean;
}

export interface IVaRepository {
  list(): Promise<VaSummary[]>;
  find(id: string): Promise<VaSummary | null>;
  findByEmail(email: string): Promise<VaSummary | null>;

  invite(input: {
    email: string;
    fullName: string;
    inviteTokenHash: string;
    inviteExpiry: Date;
  }): Promise<VaSummary>;

  /** Re-issues an invite for someone who never accepted, or whose link expired. */
  refreshInvite(
    id: string,
    inviteTokenHash: string,
    inviteExpiry: Date,
  ): Promise<VaSummary>;

  /**
   * Accepts an invite: sets the password and burns the token, atomically.
   *
   * Returns null when the token is unknown, expired or already used — the
   * caller cannot tell which, deliberately.
   */
  acceptInvite(
    inviteTokenHash: string,
    passwordHash: string,
    now: Date,
  ): Promise<{ id: string; clientId: string; email: string; fullName: string } | null>;

  revoke(id: string): Promise<void>;
  restore(id: string): Promise<void>;

  signAgreement(input: {
    vaId: string;
    documentVersion: string;
    documentHash: string;
    signedName: string;
    ipAddress: string;
    userAgent: string;
  }): Promise<void>;

  /** The per-request gate query. Deliberately tiny. */
  accessState(vaId: string): Promise<VaAccessState | null>;
}

export const VA_REPOSITORY = Symbol('VA_REPOSITORY');
