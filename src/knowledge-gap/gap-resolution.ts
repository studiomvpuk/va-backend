/**
 * What happens when the AI hits a genuine gap (PRD §5.3, §5.6).
 *
 * Two modes, set per Client:
 *
 *   GUESS_AND_PROCEED — complete the application with a best-effort answer and
 *     flag it. Nothing is time-sensitive, because the application already went
 *     out. The Client corrects it whenever convenient.
 *
 *   ASK_FIRST — pause that specific application and tell the VA it is waiting.
 *     This one IS time-sensitive: a person is blocked.
 *
 * ── Why this is a pure function ──────────────────────────────────────────────
 * The PRD requires that flipping the mode "takes effect on the next question
 * the VA hits" and not retroactively. The way to guarantee that is to make the
 * decision depend on nothing but its arguments, and to read the mode at the
 * moment a gap occurs rather than caching it anywhere.
 *
 * An application already paused under ASK_FIRST stays paused when the mode
 * flips — see `shouldResumeOnModeChange`, which answers no, deliberately.
 */

export type GapMode = 'GUESS_AND_PROCEED' | 'ASK_FIRST';

/** The model's own report of how sure it is. */
export type AnswerConfidence = 'low' | 'medium' | 'high';

export interface GapSignal {
  /** What the model produced despite the gap. */
  bestEffortAnswer: string;
  confidence: AnswerConfidence;
  /** What it had to assume. Empty means it assumed nothing. */
  assumption: string;
}

/**
 * Is this actually a gap, or just a cautious answer?
 *
 * A model saying "medium" with no assumption has answered the question from the
 * profile and is hedging about style. Treating that as a gap would bury the
 * Client in notifications about nothing, and a queue nobody reads is the same
 * as no queue.
 */
export function isGenuineGap(signal: GapSignal): boolean {
  if (signal.confidence === 'low') return true;
  return signal.confidence === 'medium' && signal.assumption.trim().length > 0;
}

export type GapAction =
  | {
      kind: 'proceed';
      /** Used in the application; the Client can correct it later. */
      answer: string;
      /** Recorded on the gap row. */
      assumption: string;
      notify: { urgent: false; title: string; body: string };
    }
  | {
      kind: 'pause';
      /** Shown to the VA, who is now blocked. */
      vaMessage: string;
      notify: { urgent: true; title: string; body: string };
    };

export interface GapContext {
  mode: GapMode;
  signal: GapSignal;
  questionText: string;
  companyName: string;
  roleTitle: string;
}

export function resolveGap(context: GapContext): GapAction {
  const where = `${context.roleTitle} at ${context.companyName}`;

  if (context.mode === 'ASK_FIRST') {
    return {
      kind: 'pause',
      vaMessage:
        `I do not have an answer for this on file, and the account owner has ` +
        `asked to be consulted before anything is guessed. They have been ` +
        `notified. This application is paused — carry on with another one and ` +
        `come back to it.`,
      notify: {
        urgent: true,
        title: `An assistant is waiting on you — ${where}`,
        // The question goes in the notification so the Client can answer from
        // it without opening anything.
        body:
          `Your assistant hit a question your profile does not answer, and this ` +
          `application is paused until you reply:\n\n"${context.questionText}"`,
      },
    };
  }

  return {
    kind: 'proceed',
    answer: context.signal.bestEffortAnswer,
    assumption: context.signal.assumption,
    notify: {
      urgent: false,
      title: `Answered for you — ${where}`,
      body:
        `Your profile did not cover this question, so it was answered as best ` +
        `it could be and the application went out:\n\n"${context.questionText}"\n\n` +
        `Answer used: "${context.signal.bestEffortAnswer}"` +
        (context.signal.assumption
          ? `\n\nAssumed: ${context.signal.assumption}`
          : '') +
        `\n\nCorrect it whenever suits — nothing is waiting on you, and the ` +
        `corrected answer is reused from then on.`,
    },
  };
}

/**
 * Does flipping the mode un-pause an application that is already waiting?
 *
 * No. Two reasons, and the second is the real one:
 *
 *   - The PRD says a mode change applies to the next gap, not retroactively.
 *   - More importantly, the Client asked to be consulted about THIS question.
 *     Proceeding without them because they later changed a general preference
 *     would be answering on their behalf after they explicitly said not to.
 *
 * They can still unblock it instantly by answering, which is the thing they
 * were asked to do.
 */
export function shouldResumeOnModeChange(): boolean {
  return false;
}
