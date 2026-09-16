/**
 * Finding a question the Client has already answered.
 *
 * PRD §5.6: "Confirmed/corrected answer is saved to the Q&A bank for every
 * future application."
 *
 * The point is that the same question is never asked twice — and "the same
 * question" is not the same string. "What is your notice period?" and "How much
 * notice do you need to give your current employer?" are one question wearing
 * two hats, and a Client who answered the first should not be asked the second.
 *
 * ── Two layers, cheapest first ───────────────────────────────────────────────
 * Normalisation catches the large majority: the same form field, worded the
 * same way, on a different job board. It is free, instant, deterministic, and
 * needs no network — which also means the Q&A bank still works when the
 * embedding provider is down.
 *
 * Cosine similarity over embeddings catches the rest. It costs a call and a
 * little latency, so it runs second and only when the first layer misses.
 */

export interface QaEntry {
  id: string;
  questionText: string;
  answer: string;
  /** null when this entry predates embeddings, or the provider was unavailable. */
  embedding: number[] | null;
}

export type MatchStrategy = 'exact' | 'semantic';

export interface QaMatch {
  entry: QaEntry;
  strategy: MatchStrategy;
  /** 1 for an exact match; the cosine score for a semantic one. */
  similarity: number;
}

/**
 * The bar a paraphrase has to clear.
 *
 * Tuned toward missing a match rather than inventing one. A miss costs the
 * Client one notification about a question they have effectively answered
 * before; a false match answers a NEW question with an OLD answer and puts
 * something untrue in a real application. Those are not symmetric.
 */
export const SEMANTIC_THRESHOLD = 0.86;

/**
 * Strips everything that varies between two askings of the same question.
 *
 * Order matters and cost a bug: stripping the filler opener BEFORE flattening
 * punctuation meant "Please tell us: what is your notice period" never matched,
 * because the pattern expected a space after "tell us" and found a colon. So
 * punctuation is flattened first and the opener is removed from the flat text.
 *
 * Deliberately conservative beyond that: it removes case, punctuation, filler
 * openers, the two form markers below and whitespace, and nothing else.
 * Stemming or synonym expansion here would start collapsing genuinely different
 * questions, and that failure is invisible until it has already been submitted.
 */
const FILLER_OPENER =
  /^(?:please\s+)?(?:could you\s+|can you\s+|kindly\s+)?(?:tell us|let us know|describe|state|confirm|provide)\s+/;

export function normaliseQuestion(question: string): string {
  return (
    question
      .toLowerCase()
      // The two "this field is mandatory" conventions. Both are removed by
      // their MARKUP — brackets and asterisk — not by the word, because
      // "is sponsorship required?" is a real question whose last word is
      // "required", and collapsing that to "is sponsorship" would merge it
      // with something else entirely.
      .replace(/\(\s*required\s*\)/g, ' ')
      .replace(/\*+\s*$/, ' ')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(FILLER_OPENER, '')
      .trim()
  );
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  // A zero vector has no direction, so similarity is undefined rather than
  // perfect. Returning 0 fails closed.
  return magnitude === 0 ? 0 : dot / magnitude;
}

/**
 * Finds the best previous answer, or nothing.
 *
 * @param queryEmbedding null when embeddings are unavailable — the exact layer
 *   still runs, which is why the Q&A bank degrades rather than breaking.
 */
export function findMatch(
  question: string,
  entries: QaEntry[],
  queryEmbedding: number[] | null,
  threshold = SEMANTIC_THRESHOLD,
): QaMatch | null {
  const normalised = normaliseQuestion(question);

  if (normalised.length > 0) {
    const exact = entries.find((e) => normaliseQuestion(e.questionText) === normalised);
    if (exact) return { entry: exact, strategy: 'exact', similarity: 1 };
  }

  if (!queryEmbedding) return null;

  let best: QaMatch | null = null;
  for (const entry of entries) {
    if (!entry.embedding) continue;
    const similarity = cosineSimilarity(queryEmbedding, entry.embedding);
    if (similarity >= threshold && (!best || similarity > best.similarity)) {
      best = { entry, strategy: 'semantic', similarity };
    }
  }
  return best;
}
