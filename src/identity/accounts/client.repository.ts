export interface ClientRecord {
  id: string;
  email: string;
  fullName: string;
  passwordHash: string;
}

export interface VaRecord {
  id: string;
  clientId: string;
  email: string;
  fullName: string;
  passwordHash: string | null;
  revokedAt: Date | null;
}

/**
 * Account lookup for authentication.
 *
 * These reads happen BEFORE a tenant is known — the account is what determines
 * the tenant — so implementations run outside tenant scope. That is why this is
 * a separate, deliberately tiny interface rather than a general Client
 * repository: the unscoped surface is kept as small as it can be, and every
 * method on it is here because authentication cannot work otherwise.
 */
export interface IAccountRepository {
  findClientByEmail(email: string): Promise<ClientRecord | null>;
  findClientById(id: string): Promise<ClientRecord | null>;
  createClient(input: {
    email: string;
    fullName: string;
    passwordHash: string;
  }): Promise<ClientRecord>;
  updateClientPasswordHash(id: string, passwordHash: string): Promise<void>;

  findVaById(id: string): Promise<VaRecord | null>;
  findVaByEmail(email: string): Promise<VaRecord | null>;
}

export const ACCOUNT_REPOSITORY = Symbol('ACCOUNT_REPOSITORY');

/** Thrown when registering an email that already has an account. */
export class EmailAlreadyRegisteredError extends Error {
  constructor() {
    super('An account with that email already exists');
    this.name = 'EmailAlreadyRegisteredError';
  }
}
