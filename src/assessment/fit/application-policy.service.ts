import { Injectable } from '@nestjs/common';

export type ApplicationVerdict = 'APPLY' | 'SKIP' | 'BORDERLINE';

export interface PolicyDecision {
  verdict: ApplicationVerdict;
  threshold: number;
  score: number;
  /** What the VA is shown, in one line. */
  summary: string;
  /** Whether the VA should be able to open the full reasoning. */
  reasoningWorthReading: boolean;
}

/**
 * Decides whether an application goes ahead.
 *
 * Separate from scoring on purpose (PRD §2.4, Single Responsibility). Scoring
 * answers "how well does this match"; this answers "so what". They change for
 * different reasons — a better rubric is a scoring change, a different risk
 * appetite is a policy change — and keeping them apart means neither edit can
 * break the other.
 *
 * It is also pure. No model, no database, no clock. Which means the rule that
 * decides whether a job gets applied for is exhaustively testable.
 */
@Injectable()
export class ApplicationPolicyService {
  /**
   * Within half a point of the threshold is borderline.
   *
   * PRD §5.5: "the VA can still request the full reasoning if they want to
   * double-check a borderline case." A hard cutoff with nothing either side of
   * it turns a 5.9 and a 2.0 into the same verdict, and they are not the same.
   */
  static readonly BORDERLINE_BAND = 0.5;

  /*
   * The band is [threshold - 0.5, threshold + 0.5): inclusive at the bottom,
   * exclusive at the top. Both comparisons therefore use >=, which is the only
   * way to keep the two edges symmetrical — an earlier version used > at the
   * bottom and sent an exactly-half-point-below score to SKIP while an
   * exactly-half-point-above one went to APPLY.
   */

  decide(score: number, threshold: number): PolicyDecision {
    const distance = score - threshold;

    if (distance >= ApplicationPolicyService.BORDERLINE_BAND) {
      return {
        verdict: 'APPLY',
        threshold,
        score,
        summary: `${score.toFixed(1)}/10 — good match. Go ahead.`,
        reasoningWorthReading: false,
      };
    }

    if (distance >= -ApplicationPolicyService.BORDERLINE_BAND) {
      return {
        verdict: 'BORDERLINE',
        threshold,
        score,
        summary:
          `${score.toFixed(1)}/10 — right on the line (threshold ` +
          `${threshold.toFixed(1)}). Worth reading why before deciding.`,
        reasoningWorthReading: true,
      };
    }

    return {
      verdict: 'SKIP',
      threshold,
      score,
      summary:
        `${score.toFixed(1)}/10 — below the ${threshold.toFixed(1)} threshold, ` +
        `so this one is skipped. No need to ask.`,
      reasoningWorthReading: true,
    };
  }
}
