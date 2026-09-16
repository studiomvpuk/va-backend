import { Injectable } from '@nestjs/common';
import { ProviderFactory } from '../../ai/provider-factory';
import {
  asUntrustedInput,
  getPrompt,
  promptVersionTag,
} from '../../ai/prompts/prompt-registry';
import {
  analysePosting,
  calibrate,
  candidateLevelFromYears,
  type Calibration,
  type SeniorityLevel,
} from '../seniority/seniority';

export interface FitInput {
  title: string;
  companyName: string;
  jobDescription: string;
  /** The Client's rubric — what they said they are looking for. */
  targetRoles: { title: string; criteria: string | null }[];
  profileNarrative: string;
  candidateYears: number;
}

export interface FitAssessment {
  /** 0–10, one decimal place. */
  score: number;
  reasoning: string;
  seniority: {
    verdict: Calibration;
    postingLevel: SeniorityLevel;
    candidateLevel: SeniorityLevel;
    /** The instruction handed to the drafter. */
    directive: string;
  };
  promptVersion: string;
}

/**
 * Scores a posting against the Client's own rubric.
 *
 * ── One job ──────────────────────────────────────────────────────────────────
 * This returns a number and an explanation. It does NOT decide whether to
 * apply — that is `ApplicationPolicyService`, and the separation is the PRD's
 * worked example of Single Responsibility: changing the rubric touches scoring,
 * changing the skip rule touches policy, and the two have genuinely different
 * reasons to change.
 *
 * Seniority is computed in code first and handed to the model as a fact, rather
 * than asked for. It is deterministic, it cannot be argued out of its answer by
 * text inside the posting, and it means the score and the drafting directive
 * are always consistent with each other.
 */
@Injectable()
export class FitScoringService {
  constructor(private readonly providers: ProviderFactory) {}

  async score(input: FitInput): Promise<FitAssessment> {
    const posting = analysePosting({
      title: input.title,
      description: input.jobDescription,
    });
    const calibration = calibrate(
      posting.level,
      candidateLevelFromYears(input.candidateYears),
    );

    const prompt = getPrompt('fit.score');
    const generator = await this.providers.textGenerator();

    const result = await generator.generate({
      system: prompt.system,
      maxTokens: 1024,
      // Zero: the same posting scored twice on the same rubric should not move.
      temperature: 0,
      cacheablePrefix: this.stableContext(input),
      messages: [
        {
          role: 'user',
          content: [
            asUntrustedInput('job_posting', `${input.title}\n\n${input.jobDescription}`),
            '',
            `Seniority (already determined, do not re-derive): the posting is ` +
              `pitched at ${posting.level}; the candidate reads as ` +
              `${calibration.candidateLevel}. Verdict: ${calibration.verdict}.`,
          ].join('\n'),
        },
      ],
    });

    const parsed = parseScore(result.text);

    return {
      score: parsed.score,
      // The calibration explanation is appended in code rather than requested,
      // so the Client always gets the "why" even when the model omits it.
      reasoning:
        calibration.verdict === 'MATCHED'
          ? parsed.reasoning
          : `${parsed.reasoning} ${calibration.explanation}`,
      seniority: {
        verdict: calibration.verdict,
        postingLevel: posting.level,
        candidateLevel: calibration.candidateLevel,
        directive: calibration.directive,
      },
      promptVersion: promptVersionTag('fit.score'),
    };
  }

  /**
   * The part that is identical for every posting this Client scores — so it is
   * the part worth caching (PRD §9). Ordering matters more than content here.
   */
  private stableContext(input: FitInput): string {
    const roles = input.targetRoles
      .map((r) => `- ${r.title}${r.criteria ? `: ${r.criteria}` : ''}`)
      .join('\n');
    return [
      'CANDIDATE PROFILE',
      input.profileNarrative,
      '',
      'WHAT THEY ARE LOOKING FOR',
      roles || '(no target roles set)',
    ].join('\n');
  }
}

interface ParsedScore {
  score: number;
  reasoning: string;
}

/**
 * Reads the model's JSON, and clamps.
 *
 * A model returning 11, or -2, or "8/10" is not a crash — it is a Tuesday. The
 * score feeds a threshold comparison, so an out-of-range value would silently
 * change which jobs get skipped.
 */
export function parseScore(raw: string): ParsedScore {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const candidates = [fenced?.[1], raw].filter(Boolean) as string[];

  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) continue;
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1)) as {
        score?: unknown;
        reasoning?: unknown;
      };
      const score = Number(parsed.score);
      if (Number.isFinite(score)) {
        return {
          score: clamp(Math.round(score * 10) / 10),
          reasoning:
            typeof parsed.reasoning === 'string' && parsed.reasoning.trim()
              ? parsed.reasoning.trim()
              : 'No reasoning was returned for this score.',
        };
      }
    } catch {
      // Try the next candidate.
    }
  }

  // Unparseable. A neutral score with an honest explanation beats both a crash
  // and a confident number nobody computed.
  return {
    score: 5,
    reasoning:
      'The scoring model returned something unreadable, so this is a neutral ' +
      'placeholder rather than a real assessment. Worth a manual look.',
  };
}

function clamp(score: number): number {
  return Math.min(10, Math.max(0, score));
}
