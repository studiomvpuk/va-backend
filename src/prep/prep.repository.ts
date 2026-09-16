import type { TalkingPoint } from './prep-validation';

export type PrepStatus = 'PENDING' | 'READY' | 'FAILED';

export interface PrepQuestion {
  question: string;
  why: string;
}

export interface PrepDocumentView {
  id: string;
  applicationId: string;
  status: PrepStatus;
  failureReason: string | null;
  companyBackground: string | null;
  likelyQuestions: PrepQuestion[];
  talkingPoints: TalkingPoint[];
  sources: string[];
  generatedAt: Date | null;
  createdAt: Date;
  companyName: string;
  roleTitle: string;
}

export interface IPrepRepository {
  /**
   * Creates the PENDING row, or returns the existing one untouched.
   *
   * Idempotent because status can be set to INTERVIEW more than once — a
   * mis-click, a retry, two tabs — and each one enqueues a job. Without this,
   * a Client who clicked twice would watch a finished document revert to
   * pending while a second identical job re-ran.
   */
  claim(applicationId: string): Promise<{ document: PrepDocumentView; created: boolean }>;

  find(applicationId: string): Promise<PrepDocumentView | null>;

  complete(
    applicationId: string,
    result: {
      companyBackground: string | null;
      likelyQuestions: PrepQuestion[];
      talkingPoints: TalkingPoint[];
      sources: string[];
    },
  ): Promise<PrepDocumentView>;

  fail(applicationId: string, reason: string): Promise<void>;

  /** The Client's own profile field keys, for checking the model's citations. */
  evidenceFor(): Promise<{ profileFieldKeys: string[]; hasNarrative: boolean }>;
}

export const PREP_REPOSITORY = Symbol('PREP_REPOSITORY');
