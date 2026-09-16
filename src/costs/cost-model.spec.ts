import { BASELINE, modelMonthlyCost } from './cost-model';
import { costOf, PRICES_CHECKED_ON, priceFor, totalCost } from './pricing';

describe('costOf', () => {
  it('prices input, cached input and output separately', () => {
    // 1M uncached in at $3, 1M out at $15.
    expect(
      costOf({ model: 'claude-sonnet-4-5', inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    ).toBe(18);
  });

  it('treats cached tokens as a subset of input, not an addition', () => {
    // The provider reports 1,000,000 input of which 900,000 were cached.
    // Adding them would charge for 1.9M and overstate every cached call.
    const cost = costOf({
      model: 'claude-sonnet-4-5',
      inputTokens: 1_000_000,
      cachedInputTokens: 900_000,
      outputTokens: 0,
    });

    // 100k at $3/M + 900k at $0.30/M = $0.30 + $0.27
    expect(cost).toBeCloseTo(0.57, 6);
  });

  it('matches a dated model id to its family', () => {
    expect(priceFor('claude-sonnet-4-5-20260514')).toEqual(priceFor('claude-sonnet-4-5'));
  });

  it('prices an unknown model as the most expensive, never as free', () => {
    // A model nobody added should make the bill look too big — that gets
    // investigated. Zero makes it look free, which does not.
    const unknown = priceFor('some-new-model-nobody-listed');
    expect(unknown.outputPerMillion).toBeGreaterThan(0);
    expect(unknown.outputPerMillion).toBe(priceFor('claude-sonnet-4-5').outputPerMillion);
  });

  it('sums a list', () => {
    expect(
      totalCost([
        { model: 'claude-haiku-4-5', inputTokens: 1_000_000, outputTokens: 0 },
        { model: 'claude-haiku-4-5', inputTokens: 1_000_000, outputTokens: 0 },
      ]),
    ).toBe(2);
  });

  it('has prices that are not yet a year old', () => {
    // Provider prices move. A test that goes red is how staleness gets noticed.
    const checked = new Date(PRICES_CHECKED_ON).getTime();
    const age = (Date.now() - checked) / (1000 * 60 * 60 * 24);
    expect(age).toBeLessThan(365);
  });
});

describe('the monthly estimate', () => {
  /**
   * ── The PRD's $30–60/month estimate is wrong, by about 15x ─────────────────
   *
   * At the prices in pricing.ts, the baseline month costs about **$2.35**, and
   * the worst plausible case — a 6,000-token profile, 200 postings, 80
   * applications, five questions each, and a cache that never hits — is about
   * **$18.62**. Every point in the plausible space sits below the bottom of the
   * range the estimate assumed.
   *
   * The reason is that per-token prices have fallen a long way, and the shape
   * of this product suits them: the expensive part of a call is output tokens,
   * and this product's outputs are short. A CV draft costs roughly 1.6 cents.
   *
   * The number matters because a per-Client price was going to be set against
   * it. These assertions are the bracket the pilot has to land inside; if real
   * usage comes back above $20 the model here is missing something and the
   * assumptions, not the assertion, are what should change.
   */
  it('costs far less than the PRD assumed, at every plausible point', () => {
    expect(modelMonthlyCost().total).toBeLessThan(5);

    const worstCase = modelMonthlyCost({
      ...BASELINE,
      profileTokens: 6_000,
      postingTokens: 1_800,
      postingsAssessed: 200,
      applicationsSubmitted: 80,
      questionsPerApplication: 5,
      interviews: 6,
      cacheHitRate: 0,
    }).total;

    expect(worstCase).toBeLessThan(25);
  });

  it('accounts for every stage of the loop', () => {
    const labels = modelMonthlyCost().lines.map((l) => l.label);
    expect(labels).toEqual([
      'Fit scoring',
      'CV + cover letter',
      'Screening answers',
      'Gap detection',
      'Q&A bank embeddings',
      'Interview prep',
    ]);
  });

  it('is dominated by drafting, not by scoring', () => {
    // Output tokens cost five times input, and drafting is where the long
    // outputs are. If scoring ever dominates, something is calling the
    // expensive model on every posting — which is the bug worth catching.
    const lines = modelMonthlyCost().lines;
    const drafting = lines.find((l) => l.label === 'CV + cover letter')!.cost;
    const scoring = lines.find((l) => l.label === 'Fit scoring')!.cost;

    expect(drafting).toBeGreaterThan(scoring);
  });

  it('is sensitive to the cache hit rate, which is the lever to watch', () => {
    const warm = modelMonthlyCost({ ...BASELINE, cacheHitRate: 0.9 }).total;
    const cold = modelMonthlyCost({ ...BASELINE, cacheHitRate: 0 }).total;

    expect(cold).toBeGreaterThan(warm);
  });

  it('scales with the profile, because it is prepended to every call', () => {
    const small = modelMonthlyCost({ ...BASELINE, profileTokens: 1_000 }).total;
    const large = modelMonthlyCost({ ...BASELINE, profileTokens: 8_000 }).total;

    expect(large).toBeGreaterThan(small);
  });

  it('costs almost nothing for a Client who applies to nothing', () => {
    const { total } = modelMonthlyCost({
      ...BASELINE,
      postingsAssessed: 0,
      applicationsSubmitted: 0,
      interviews: 0,
    });
    expect(total).toBe(0);
  });
});
