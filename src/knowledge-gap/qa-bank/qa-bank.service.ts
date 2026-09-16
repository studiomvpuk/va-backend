import { Inject, Injectable, Logger } from '@nestjs/common';
import { ProviderFactory } from '../../ai/provider-factory';
import type { IEmbedder } from '../../ai/providers/ai-provider.interface';
import { QA_BANK_REPOSITORY, type IQaBankRepository } from './qa-bank.repository';
import { findMatch, type QaEntry, type QaMatch } from './qa-matcher';

/**
 * "Has the Client already answered this?"
 *
 * Sits between the pure matcher and the world: it fetches the bank, gets a
 * vector for the incoming question, and decides which stored vectors are even
 * comparable. The ranking itself stays in qa-matcher.ts, where it can be tested
 * against hand-built vectors with no database and no network.
 *
 * ── Degradation is the design, not a fallback ───────────────────────────────
 * Every embedding call here is best-effort. When the embedder is down, over
 * quota, or simply not configured, lookups still run — they just run on exact
 * matching alone. The cost of that is one extra question to the Client. The
 * cost of throwing instead would be a stalled application, which is worse, and
 * it would make the Q&A bank a hard dependency on a third party for a feature
 * whose entire purpose is convenience.
 */
@Injectable()
export class QaBankService {
  private readonly logger = new Logger(QaBankService.name);

  constructor(
    @Inject(QA_BANK_REPOSITORY) private readonly repository: IQaBankRepository,
    private readonly providers: ProviderFactory,
  ) {}

  /**
   * The §5.5a `qaBankHit` input: a previous answer, or nothing.
   *
   * Never throws. A caller deciding how to draft should not have to handle an
   * embedding provider's rate limit.
   */
  async lookup(question: string): Promise<QaMatch | null> {
    const [rows, embedder] = await Promise.all([
      this.repository.list(),
      this.embedder(),
    ]);
    if (rows.length === 0) return null;

    const queryEmbedding = embedder
      ? await this.embedOne(embedder, question)
      : null;

    const entries: QaEntry[] = rows.map((row) => ({
      id: row.id,
      questionText: row.questionText,
      answer: row.answer,
      embedding: this.comparableVector(row.embedding, row.embeddingModel, embedder),
    }));

    return findMatch(question, entries, queryEmbedding);
  }

  /**
   * Called when the Client confirms or corrects an answer (PRD §5.6).
   *
   * The embedding is written at this point rather than at lookup time because
   * this is the one moment the text is known to be final. Embedding a draft
   * answer would cost a call for a string that may be about to change.
   */
  async record(input: {
    questionText: string;
    answer: string;
    sourceGapId?: string;
  }): Promise<void> {
    const embedder = await this.embedder();
    const vector = embedder ? await this.embedOne(embedder, input.questionText) : null;

    await this.repository.upsert({
      questionText: input.questionText,
      answer: input.answer,
      // An empty vector, not a fabricated one. `embeddingModel: null` is then
      // the honest record that this row has never been embedded, and a later
      // backfill can find it with exactly that query.
      embedding: vector ?? [],
      embeddingModel: vector ? embedder!.embeddingModel : null,
      ...(input.sourceGapId ? { sourceGapId: input.sourceGapId } : {}),
    });
  }

  count(): Promise<number> {
    return this.repository.countForClient();
  }

  // ───────────────────────────────────────────────────────────── internals

  /**
   * A stored vector is comparable only if the SAME embedder produced it.
   *
   * Two models' vectors can have identical width and no shared meaning
   * whatsoever, so comparing them does not fail — it silently returns numbers,
   * and those numbers occasionally clear the threshold. That is the one failure
   * mode that puts a wrong answer into a real job application, so the check is
   * on identity of the model, not on width.
   *
   * A mismatch is not an error: the row simply loses its vector and is still
   * available for exact matching.
   */
  private comparableVector(
    embedding: number[],
    embeddingModel: string | null,
    embedder: IEmbedder | null,
  ): number[] | null {
    if (!embedder || !embeddingModel) return null;
    if (embeddingModel !== embedder.embeddingModel) return null;
    if (embedding.length !== embedder.dimensions) return null;
    return embedding;
  }

  private async embedder(): Promise<IEmbedder | null> {
    try {
      return await this.providers.embedder();
    } catch (e) {
      // No key configured is the common case here, and it is not an incident.
      this.logger.debug(`no embedder available: ${describe(e)}`);
      return null;
    }
  }

  private async embedOne(embedder: IEmbedder, text: string): Promise<number[] | null> {
    try {
      const { vectors } = await embedder.embed({ texts: [text] });
      const vector = vectors[0];
      return vector && vector.length === embedder.dimensions ? vector : null;
    } catch (e) {
      this.logger.warn(
        `embedding failed, falling back to exact matching: ${describe(e)}`,
      );
      return null;
    }
  }
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
