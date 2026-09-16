import { decideResume } from './resume-rule';

describe('decideResume', () => {
  it('resumes a blocked application once nothing is left unanswered', () => {
    expect(
      decideResume({ applicationStatus: 'BLOCKED', remainingUnresolvedGaps: 0 }),
    ).toEqual({ resume: true, toStatus: 'IN_PROGRESS' });
  });

  it('keeps an application blocked while other questions are still waiting', () => {
    // A form with three fields the profile does not cover produces three gaps.
    // Resuming after the first answer sends the VA back to a form they still
    // cannot finish.
    const decision = decideResume({
      applicationStatus: 'BLOCKED',
      remainingUnresolvedGaps: 2,
    });

    expect(decision.resume).toBe(false);
    expect(decision).toMatchObject({ reason: expect.stringContaining('2') });
  });

  it.each(['APPLIED', 'IN_PROGRESS', 'SCORED', 'INTERVIEW'])(
    'does not touch an application in %s',
    (applicationStatus) => {
      // GUESS_AND_PROCEED never blocked it — the application already went out,
      // and the answer is a correction for next time.
      expect(
        decideResume({ applicationStatus, remainingUnresolvedGaps: 0 }),
      ).toMatchObject({ resume: false });
    },
  );
});
