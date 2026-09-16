export interface SiteView {
  id: string;
  name: string;
  url: string;
  username: string;
  status: 'NOT_CONNECTED' | 'CONNECTED';
  createdAt: Date;
}

export interface VaRecordForGate {
  id: string;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface ISiteRepository {
  list(): Promise<SiteView[]>;
  find(id: string): Promise<SiteView | null>;
  create(input: { name: string; url: string; username: string }): Promise<SiteView>;
  update(
    id: string,
    changes: { name?: string; url?: string; username?: string },
  ): Promise<SiteView>;
  remove(id: string): Promise<void>;

  /** For the §7.4 gate: when did this VA join, and are they still active? */
  findVa(vaId: string): Promise<VaRecordForGate | null>;
}

/**
 * A site name that is already taken for this Client.
 *
 * A domain error, not a Prisma one: the service layer decides what a duplicate
 * name means to a person, and has no business knowing that the database calls
 * it P2002. Before this existed, the constraint escaped as an unhandled Prisma
 * error and the Client saw "Internal server error" for a name they had used
 * five minutes earlier.
 */
export class SiteNameTakenError extends Error {
  constructor(readonly name: string) {
    super(`A site called "${name}" already exists`);
  }
}

export const SITE_REPOSITORY = Symbol('SITE_REPOSITORY');
