/**
 * What a token costs, per model, in USD.
 *
 * ── Why these live in code with a date on them ──────────────────────────────
 * They are a third party's prices and they change. Reading them from a config
 * file would mean a stale file nobody notices; fetching them would mean an
 * outbound call on every cost calculation. Pinning them here, with the date
 * they were checked, makes staleness visible in a diff and lets a test fail
 * when they are older than a quarter.
 *
 * Every figure is per MILLION tokens, which is how every provider publishes
 * them — converting at the point of use is where an order-of-magnitude error
 * gets in.
 */
export const PRICES_CHECKED_ON = '2026-09-16';

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  /**
   * What a cached input token costs. Both providers discount heavily, and this
   * product is unusually well suited to it: the Client's profile is identical
   * on every call they make, so it is the cache-hit rate that decides the bill.
   */
  cachedInputPerMillion: number;
}

export const PRICING: Record<string, ModelPricing> = {
  'claude-sonnet-4-5': { inputPerMillion: 3, outputPerMillion: 15, cachedInputPerMillion: 0.3 },
  'claude-haiku-4-5': { inputPerMillion: 1, outputPerMillion: 5, cachedInputPerMillion: 0.1 },
  'gpt-4.1': { inputPerMillion: 2, outputPerMillion: 8, cachedInputPerMillion: 0.5 },
  'gpt-4.1-mini': { inputPerMillion: 0.4, outputPerMillion: 1.6, cachedInputPerMillion: 0.1 },
  'text-embedding-3-small': {
    inputPerMillion: 0.02,
    outputPerMillion: 0,
    cachedInputPerMillion: 0.02,
  },
  'whisper-1': { inputPerMillion: 0, outputPerMillion: 0, cachedInputPerMillion: 0 },
  echo: { inputPerMillion: 0, outputPerMillion: 0, cachedInputPerMillion: 0 },
};

/**
 * An unknown model costs the most expensive thing on the list, not zero.
 *
 * A new model that nobody added here should make the bill look too big, which
 * somebody investigates. Defaulting to zero makes it look free, which nobody
 * investigates until the invoice arrives.
 */
export function priceFor(model: string): ModelPricing {
  const exact = PRICING[model];
  if (exact) return exact;

  // Provider model ids carry dated suffixes: `claude-sonnet-4-5-20260514`.
  const prefixed = Object.keys(PRICING).find((known) => model.startsWith(known));
  if (prefixed) return PRICING[prefixed];

  return Object.values(PRICING).reduce((worst, price) =>
    price.outputPerMillion > worst.outputPerMillion ? price : worst,
  );
}

export interface Usage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

/** USD, to six places — a single call is often a fraction of a cent. */
export function costOf(usage: Usage): number {
  const price = priceFor(usage.model);
  const cached = usage.cachedInputTokens ?? 0;
  // Providers report cached tokens as a SUBSET of input tokens, not in addition
  // to them. Adding the two would double-count the cached portion and overstate
  // every cached call.
  const uncached = Math.max(0, usage.inputTokens - cached);

  const dollars =
    (uncached * price.inputPerMillion +
      cached * price.cachedInputPerMillion +
      usage.outputTokens * price.outputPerMillion) /
    1_000_000;

  return Math.round(dollars * 1_000_000) / 1_000_000;
}

export function totalCost(usages: Usage[]): number {
  return Math.round(usages.reduce((sum, u) => sum + costOf(u), 0) * 1_000_000) / 1_000_000;
}
