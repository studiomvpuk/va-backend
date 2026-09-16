/**
 * The §5.5a model orchestration rule.
 *
 * "If the context is clear (the Client's profile/Q&A bank has enough to answer
 *  confidently): Claude drafts directly.
 *  If the context is not clear (a genuine gap, ambiguous fit, or thin
 *  information): GPT generates the first-pass content, then Claude refines it."
 *
 * ── Why this is a pure function ──────────────────────────────────────────────
 * The PRD's acceptance criterion is that "the same orchestration path is chosen
 * deterministically for the same input". That rules out asking a model whether
 * the context is clear — two calls, two answers, and a routing decision nobody
 * can reproduce when they are trying to explain a bad draft six weeks later.
 *
 * So the model decides CONTENT and code decides ROUTING, over structured facts
 * the caller already has: how much profile there is, whether the Q&A bank
 * answered, whether a gap was flagged, and how confident the fit read was.
 *
 * No clock, no randomness, no I/O. Given the same facts it returns the same
 * path, forever, and the chosen path is written to the Draft row.
 */

export type OrchestrationPath = 'claude_direct' | 'gpt_then_claude';

export interface ContextFacts {
  /** Characters of free-form experience the Client has written. */
  profileNarrativeLength: number;
  /** Structured fields with a value. */
  populatedFieldCount: number;
  /** A confirmed answer to this exact question already exists. */
  qaBankHit: boolean;
  /** The caller has already determined this is a genuine knowledge gap. */
  isKnownGap: boolean;
  /** From the seniority read — `low` means the posting was unreadable. */
  fitConfidence: 'high' | 'medium' | 'low';
  /** Characters of job description. A stub posting is thin context too. */
  jobDescriptionLength: number;
}

export interface RoutingDecision {
  path: OrchestrationPath;
  /** Every reason that applied, in a fixed order, for the Draft row and the log. */
  reasons: string[];
}

/**
 * Thresholds.
 *
 * Deliberately generous. Routing through GPT-then-Claude is a cost, not a
 * failure — it is what the PRD prescribes for thin context, and being wrong in
 * that direction produces a better draft slightly slower. Being wrong the other
 * way produces a confident draft from nothing.
 */
export const THRESHOLDS = {
  /** Below this, the Client has barely told us anything. */
  minNarrativeLength: 200,
  /** Fewer than this and there is little structured material to draw on. */
  minPopulatedFields: 3,
  /** A posting shorter than this is a stub, not a description. */
  minJobDescriptionLength: 200,
} as const;

export function chooseOrchestrationPath(facts: ContextFacts): RoutingDecision {
  const reasons: string[] = [];

  // A confirmed answer already exists. Nothing is thin about that, whatever
  // else is missing — checked first because it overrides the rest.
  if (facts.qaBankHit) {
    return { path: 'claude_direct', reasons: ['answered before and confirmed'] };
  }

  if (facts.isKnownGap) reasons.push('a genuine knowledge gap');
  if (facts.fitConfidence === 'low') reasons.push('the posting’s level was unreadable');
  if (facts.profileNarrativeLength < THRESHOLDS.minNarrativeLength) {
    reasons.push('little written experience on file');
  }
  if (facts.populatedFieldCount < THRESHOLDS.minPopulatedFields) {
    reasons.push('few structured profile fields');
  }
  if (facts.jobDescriptionLength < THRESHOLDS.minJobDescriptionLength) {
    reasons.push('the job description is very short');
  }

  return reasons.length > 0
    ? { path: 'gpt_then_claude', reasons }
    : { path: 'claude_direct', reasons: ['profile covers this'] };
}

/** `gpt_then_claude` — what gets written to Draft.orchestrationPath. */
export function pathLabel(decision: RoutingDecision): OrchestrationPath {
  return decision.path;
}
