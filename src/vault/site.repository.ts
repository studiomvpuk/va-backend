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

export const SITE_REPOSITORY = Symbol('SITE_REPOSITORY');
