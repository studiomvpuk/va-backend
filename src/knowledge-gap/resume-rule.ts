/**
 * Whether answering a gap un-blocks the application it belongs to.
 *
 * Small enough to inline, kept separate because it is the point where two
 * things that look alike are not: "this gap is answered" and "this application
 * can continue". An application can be blocked on several questions at once —
 * a form with three fields the profile does not cover produces three gaps — and
 * resuming after the first answer would send the VA back to a form they still
 * cannot finish.
 */
export type ResumeDecision =
  | { resume: true; toStatus: 'IN_PROGRESS' }
  | { resume: false; reason: string };

export function decideResume(input: {
  applicationStatus: string;
  remainingUnresolvedGaps: number;
}): ResumeDecision {
  if (input.applicationStatus !== 'BLOCKED') {
    // GUESS_AND_PROCEED never blocked it, so there is nothing to resume — the
    // application has usually already been submitted by this point, and the
    // answer is a correction for next time rather than an unblocking.
    return { resume: false, reason: 'application was not blocked' };
  }

  if (input.remainingUnresolvedGaps > 0) {
    return {
      resume: false,
      reason: `${input.remainingUnresolvedGaps} more question(s) still unanswered`,
    };
  }

  return { resume: true, toStatus: 'IN_PROGRESS' };
}
