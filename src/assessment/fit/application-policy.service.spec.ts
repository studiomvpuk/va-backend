import { ApplicationPolicyService } from './application-policy.service';

describe('ApplicationPolicyService', () => {
  const policy = new ApplicationPolicyService();
  const T = 6.0;

  describe('clearly above', () => {
    it.each([6.5, 7.5, 10])('%s applies', (score) => {
      expect(policy.decide(score, T).verdict).toBe('APPLY');
    });

    it('does not push the VA to read the reasoning', () => {
      // The whole point of the threshold is that the VA does not have to make a
      // judgement call on every job.
      expect(policy.decide(8.0, T).reasoningWorthReading).toBe(false);
    });
  });

  describe('clearly below', () => {
    it.each([5.4, 4.0, 0])('%s skips', (score) => {
      expect(policy.decide(score, T).verdict).toBe('SKIP');
    });

    /** PRD §5.5: the VA sees the score AND the verdict without asking. */
    it('says it is skipped and that no question is needed', () => {
      const decision = policy.decide(4.0, T);
      expect(decision.summary).toContain('4.0/10');
      expect(decision.summary).toMatch(/below the 6.0 threshold/);
      expect(decision.summary).toMatch(/no need to ask/i);
    });
  });

  describe('borderline', () => {
    it.each([5.5, 5.9, 6.0, 6.4])('%s is borderline', (score) => {
      expect(policy.decide(score, T).verdict).toBe('BORDERLINE');
    });

    it('invites the VA to read why', () => {
      expect(policy.decide(6.0, T).reasoningWorthReading).toBe(true);
      expect(policy.decide(6.0, T).summary).toMatch(/worth reading why/i);
    });

    it('exists because 5.9 and 2.0 are not the same thing', () => {
      // A hard cutoff would give these identical verdicts.
      expect(policy.decide(5.9, T).verdict).not.toBe(policy.decide(2.0, T).verdict);
    });
  });

  describe('boundaries', () => {
    it('is exact at the band edges', () => {
      expect(policy.decide(6.5, T).verdict).toBe('APPLY');
      expect(policy.decide(6.4, T).verdict).toBe('BORDERLINE');
      expect(policy.decide(5.5, T).verdict).toBe('BORDERLINE');
      expect(policy.decide(5.4, T).verdict).toBe('SKIP');
    });

    it('moves with the Client’s threshold', () => {
      // The same 7.5 is a clear apply at 6.0 and a skip at 9.0.
      expect(policy.decide(7.5, 6.0).verdict).toBe('APPLY');
      expect(policy.decide(7.5, 9.0).verdict).toBe('SKIP');
    });

    it('handles a threshold of 0 — apply to everything', () => {
      expect(policy.decide(0, 0).verdict).toBe('BORDERLINE');
      expect(policy.decide(1, 0).verdict).toBe('APPLY');
    });

    it('handles a threshold of 10 — apply to almost nothing', () => {
      expect(policy.decide(10, 10).verdict).toBe('BORDERLINE');
      expect(policy.decide(9.0, 10).verdict).toBe('SKIP');
    });
  });

  it('always reports the numbers it decided on', () => {
    const decision = policy.decide(7.2, 6.5);
    expect(decision.score).toBe(7.2);
    expect(decision.threshold).toBe(6.5);
  });
});
