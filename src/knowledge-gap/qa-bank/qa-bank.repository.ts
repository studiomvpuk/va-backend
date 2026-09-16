/**
 * The Q&A bank's storage seam.
 *
 * Narrow on purpose. There is no `findMany` taking a where clause, no update
 * by arbitrary field, and no delete — the bank is append-and-correct only, and
 * a shape that cannot express "give me someone else's answers" is a better
 * guarantee than a rule saying don't.
 */

export interface QaBankRow {
  id: string;
  questionText: string;
  answer: string;
  /** Empty when the embedder was unavailable at write time. */
  embedding: number[];
  /** Which embedder produced `embedding`. Null on rows written without one. */
  embeddingModel: string | null;
  confirmedAt: Date;
}

export interface UpsertQaEntry {
  questionText: string;
  answer: string;
  embedding: number[];
  embeddingModel: string | null;
  sourceGapId?: string;
}

export interface IQaBankRepository {
  /**
   * Every entry for the Client in context.
   *
   * Returns the whole bank rather than a filtered subset because matching is a
   * pure function over the full set (see qa-matcher.ts) and is far easier to
   * reason about when the storage layer does no ranking. At the sizes this
   * table reaches per Client, the difference is not measurable.
   */
  list(): Promise<QaBankRow[]>;

  /**
   * Insert, or replace the answer on an entry with the same normalised
   * question.
   *
   * Upsert rather than insert because a Client who corrects an answer they
   * already gave must end up with one entry, not two that disagree — and if
   * two disagreed, which one a future application used would be arbitrary.
   */
  upsert(entry: UpsertQaEntry): Promise<QaBankRow>;

  countForClient(): Promise<number>;
}

export const QA_BANK_REPOSITORY = Symbol('QA_BANK_REPOSITORY');
