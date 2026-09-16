export type AppStatus =
  | 'SCORED' | 'SKIPPED' | 'IN_PROGRESS' | 'BLOCKED'
  | 'APPLIED' | 'INTERVIEW' | 'REJECTED' | 'OFFER';

export type SeniorityVerdict = 'UNDER_LEVELLED' | 'MATCHED' | 'OVER_LEVELLED';

export interface ApplicationView {
  id: string;
  companyName: string;
  roleTitle: string;
  fitScore: number | null;
  fitReasoning: string | null;
  seniorityVerdict: SeniorityVerdict | null;
  status: AppStatus;
  createdAt: Date;
  appliedAt: Date | null;
}

export interface DraftView {
  id: string;
  kind: 'CV' | 'COVER_LETTER' | 'SCREENING_ANSWER';
  questionText: string | null;
  body: string;
  orchestrationPath: string;
  promptVersion: string;
  createdAt: Date;
}

/**
 * The four dashboard figures.
 *
 * Computed in the database, not in the browser over the tracker's rows. The
 * tracker is paginated — it has to be, at 500 applications — so a client-side
 * count would silently describe the first page rather than the account, and
 * would go quietly wrong exactly when the Client has enough history for the
 * numbers to matter.
 */
export interface ApplicationStats {
  /** Submitted, not merely scored: a skipped posting is not an application. */
  applications: number;
  interviews: number;
  /** Applications paused on a knowledge gap. */
  waitingOnYou: number;
  /**
   * Over everything scored, including skipped postings — this answers "what is
   * my assistant finding for me", which is a question about the search rather
   * than about what was applied to.
   */
  averageFit: number;
}

export interface IApplicationRepository {
  list(filter?: { status?: AppStatus; limit?: number }): Promise<ApplicationView[]>;
  stats(): Promise<ApplicationStats>;
  find(id: string): Promise<ApplicationView | null>;

  create(input: {
    vaId: string | null;
    siteId: string | null;
    companyName: string;
    roleTitle: string;
    jobDescription: string;
    fitScore: number;
    fitReasoning: string;
    seniorityVerdict: SeniorityVerdict;
    status: AppStatus;
  }): Promise<ApplicationView>;

  updateStatus(id: string, status: AppStatus): Promise<ApplicationView>;

  /** The full posting. Needed for drafting; not in the list view. */
  jobDescription(id: string): Promise<string | null>;

  addDraft(input: {
    applicationId: string;
    kind: 'CV' | 'COVER_LETTER' | 'SCREENING_ANSWER';
    questionText: string | null;
    body: string;
    orchestrationPath: string;
    promptVersion: string;
    atsChecked: boolean;
  }): Promise<DraftView>;

  drafts(applicationId: string): Promise<DraftView[]>;

  countThisWeek(): Promise<number>;
}

export const APPLICATION_REPOSITORY = Symbol('APPLICATION_REPOSITORY');
