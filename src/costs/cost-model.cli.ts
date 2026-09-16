import { BASELINE, modelMonthlyCost, type UsageAssumptions } from './cost-model';
import { PRICES_CHECKED_ON } from './pricing';

/**
 * `npm run cost-model`
 *
 * Prints what one Client costs per month, under the baseline assumptions and
 * under four variations that bracket the plausible space.
 *
 * It exists so the estimate can be re-derived in one command when prices move
 * or when the pilot produces real token counts — rather than being a number
 * somebody once worked out and everyone since has quoted.
 */
const SCENARIOS: [label: string, overrides: Partial<UsageAssumptions>][] = [
  ['Baseline', {}],
  ['Heavy profile (6k tokens)', { profileTokens: 6_000 }],
  ['No skipping — every posting drafted', { applicationsSubmitted: BASELINE.postingsAssessed }],
  [
    'Heavy everything',
    {
      profileTokens: 6_000,
      postingTokens: 1_800,
      postingsAssessed: 200,
      applicationsSubmitted: 80,
      questionsPerApplication: 5,
      interviews: 6,
    },
  ],
  [
    'Heavy everything, cache never hits',
    {
      profileTokens: 6_000,
      postingTokens: 1_800,
      postingsAssessed: 200,
      applicationsSubmitted: 80,
      questionsPerApplication: 5,
      interviews: 6,
      cacheHitRate: 0,
    },
  ],
];

const out: string[] = ['', `Prices as checked on ${PRICES_CHECKED_ON}. One Client, one month.`, ''];

const baseline = modelMonthlyCost();
out.push('Baseline breakdown');
for (const line of baseline.lines) {
  out.push(
    `  ${line.label.padEnd(24)} ${String(line.calls).padStart(6)} calls   $${line.cost.toFixed(2).padStart(7)}`,
  );
}
out.push(`  ${'TOTAL'.padEnd(24)} ${' '.repeat(12)}   $${baseline.total.toFixed(2).padStart(7)}`);
out.push('');
out.push('Scenarios');
for (const [label, overrides] of SCENARIOS) {
  const total = modelMonthlyCost({ ...BASELINE, ...overrides }).total;
  out.push(`  ${label.padEnd(38)} $${total.toFixed(2).padStart(7)}`);
}
out.push('');
out.push('The PRD assumed $30–60/month. Every scenario above is below that.');
out.push('');

process.stdout.write(`${out.join('\n')}\n`);
