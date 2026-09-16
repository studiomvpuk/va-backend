export interface KnowledgeGapView {
  id: string;
  applicationId: string;
  vaId: string;
  questionText: string;
  /** Null in ASK_FIRST mode: nothing was guessed, so there is nothing to show. */
  bestEffortAnswer: string | null;
  clientAnswer: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  /** For the dashboard queue, so the Client knows which application is waiting. */
  companyName: string;
  roleTitle: string;
  applicationStatus: string;
}

export interface CreateGapInput {
  applicationId: string;
  vaId: string;
  questionText: string;
  bestEffortAnswer: string | null;
}

export interface IKnowledgeGapRepository {
  create(input: CreateGapInput): Promise<KnowledgeGapView>;
  findById(id: string): Promise<KnowledgeGapView | null>;
  list(input: { unresolvedOnly: boolean; limit: number }): Promise<KnowledgeGapView[]>;
  countUnresolved(): Promise<number>;

  /**
   * Records the Client's answer and resolves the gap, then reports whether the
   * application it belongs to still has any unresolved gaps.
   *
   * One method because it is one transaction. Answering a gap and reading back
   * "is anything else still blocking this application" as two calls leaves a
   * window in which a second gap resolves in between, and both callers then
   * decide the application is clear to resume.
   */
  resolve(
    id: string,
    clientAnswer: string,
  ): Promise<{ gap: KnowledgeGapView; remainingForApplication: number }>;

  /** Gaps still waiting, for one application. */
  countUnresolvedForApplication(applicationId: string): Promise<number>;
}

export const KNOWLEDGE_GAP_REPOSITORY = Symbol('KNOWLEDGE_GAP_REPOSITORY');
