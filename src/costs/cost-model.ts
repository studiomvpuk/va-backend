import { costOf, type Usage } from './pricing';

/**
 * What one Client costs per month — modelled, so the estimate can be argued
 * with rather than believed.
 *
 * PRD Phase 10: "A short pilot to confirm real token counts against the
 * ~$30–60/month estimate before committing to any pricing."
 *
 * The pilot has not run yet. What this does is make the estimate falsifiable:
 * every input is named, the arithmetic is here, and `npm run cost-model` prints
 * the result. When real usage arrives, the measured token counts replace the
 * assumed ones and the same function produces the real number — rather than
 * someone re-deriving it in a spreadsheet and getting a different answer.
 */

export interface UsageAssumptions {
  /** Postings the VA pastes in. Most are scored and skipped. */
  postingsAssessed: number;
  /** Of those, the ones that clear the fit threshold and get applied to. */
  applicationsSubmitted: number;
  /** Screening questions per application. */
  questionsPerApplication: number;
  /** Interviews, each of which generates a prep document. */
  interviews: number;

  /**
   * The Client's profile, in tokens. This is the number that matters most: it
   * is prepended to every single call, so it multiplies by everything above.
   */
  profileTokens: number;
  /** A job description, in tokens. */
  postingTokens: number;

  /**
   * How often the provider's prompt cache actually hits.
   *
   * The dominant lever, and the one most likely to be wrong. Caches expire —
   * Anthropic's default TTL is five minutes — so a VA working steadily through
   * a batch hits warm, and one who does two applications a day mostly misses.
   * 0.8 assumes batched work, which is how the product is meant to be used and
   * therefore the optimistic end.
   */
  cacheHitRate: number;
}

/** The PRD's working assumptions, one Client, one month. */
export const BASELINE: UsageAssumptions = {
  postingsAssessed: 120,
  applicationsSubmitted: 40,
  questionsPerApplication: 3,
  interviews: 3,
  profileTokens: 2_000,
  postingTokens: 900,
  cacheHitRate: 0.8,
};

export interface CostBreakdown {
  /** USD per line item. */
  lines: { label: string; calls: number; cost: number }[];
  total: number;
}

/**
 * Builds the month's calls and prices them.
 *
 * Deliberately built as a list of real `Usage` records rather than a formula:
 * the same `costOf` prices these as prices production traffic, so a mistake in
 * the pricing table shows up in both or neither. A closed-form estimate would
 * have its own arithmetic to get wrong.
 */
export function modelMonthlyCost(assumptions: UsageAssumptions = BASELINE): CostBreakdown {
  const { cacheHitRate: hit } = assumptions;
  const cached = (tokens: number) => Math.round(tokens * hit);

  const lines: { label: string; calls: number; usages: Usage[] }[] = [];

  // Fit scoring: every posting, cheap model, short output.
  lines.push({
    label: 'Fit scoring',
    calls: assumptions.postingsAssessed,
    usages: repeat(assumptions.postingsAssessed, {
      model: 'claude-haiku-4-5',
      inputTokens: assumptions.profileTokens + assumptions.postingTokens,
      cachedInputTokens: cached(assumptions.profileTokens),
      outputTokens: 150,
    }),
  });

  // CV and cover letter: only for applications that go out. Long outputs, which
  // is where the money is — output tokens cost five times input.
  lines.push({
    label: 'CV + cover letter',
    calls: assumptions.applicationsSubmitted * 2,
    usages: repeat(assumptions.applicationsSubmitted * 2, {
      model: 'claude-sonnet-4-5',
      inputTokens: assumptions.profileTokens + assumptions.postingTokens,
      cachedInputTokens: cached(assumptions.profileTokens),
      outputTokens: 800,
    }),
  });

  // Screening answers: many, short.
  const questions = assumptions.applicationsSubmitted * assumptions.questionsPerApplication;
  lines.push({
    label: 'Screening answers',
    calls: questions,
    usages: repeat(questions, {
      model: 'claude-sonnet-4-5',
      inputTokens: assumptions.profileTokens + 200,
      cachedInputTokens: cached(assumptions.profileTokens),
      outputTokens: 120,
    }),
  });

  // The gap detector runs on the questions the Q&A bank missed. Assumed at a
  // third, falling over time as the bank fills — which is the point of it.
  const gaps = Math.round(questions / 3);
  lines.push({
    label: 'Gap detection',
    calls: gaps,
    usages: repeat(gaps, {
      model: 'claude-sonnet-4-5',
      inputTokens: assumptions.profileTokens + 200,
      cachedInputTokens: cached(assumptions.profileTokens),
      outputTokens: 150,
    }),
  });

  // Embeddings: one per bank lookup and one per answer stored. Rounding error.
  lines.push({
    label: 'Q&A bank embeddings',
    calls: questions + gaps,
    usages: repeat(questions + gaps, {
      model: 'text-embedding-3-small',
      inputTokens: 30,
      outputTokens: 0,
    }),
  });

  // Prep documents: a long prompt, a long output, and rare.
  lines.push({
    label: 'Interview prep',
    calls: assumptions.interviews,
    usages: repeat(assumptions.interviews, {
      model: 'claude-sonnet-4-5',
      inputTokens: assumptions.profileTokens + assumptions.postingTokens + 2_500,
      cachedInputTokens: cached(assumptions.profileTokens),
      outputTokens: 1_500,
    }),
  });

  const priced = lines.map((line) => ({
    label: line.label,
    calls: line.calls,
    cost: round(line.usages.reduce((sum, u) => sum + costOf(u), 0)),
  }));

  return { lines: priced, total: round(priced.reduce((sum, l) => sum + l.cost, 0)) };
}

function repeat(count: number, usage: Usage): Usage[] {
  return Array.from({ length: Math.max(0, count) }, () => usage);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
