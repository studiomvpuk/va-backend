import {
  chooseOrchestrationPath,
  THRESHOLDS,
  type ContextFacts,
} from './orchestration-rule';

/** Rich context: everything present, nothing flagged. */
const CLEAR: ContextFacts = {
  profileNarrativeLength: 1200,
  populatedFieldCount: 8,
  qaBankHit: false,
  isKnownGap: false,
  fitConfidence: 'high',
  jobDescriptionLength: 2400,
};

describe('the §5.5a orchestration rule', () => {
  describe('claude_direct — context is clear', () => {
    it('routes a full profile against a real posting', () => {
      expect(chooseOrchestrationPath(CLEAR).path).toBe('claude_direct');
    });

    it('explains itself even when nothing was wrong', () => {
      expect(chooseOrchestrationPath(CLEAR).reasons).toEqual(['profile covers this']);
    });

    it('a confirmed previous answer overrides everything else', () => {
      // If they have answered this before and confirmed it, the context is not
      // thin however sparse the rest of the profile is.
      const decision = chooseOrchestrationPath({
        ...CLEAR,
        qaBankHit: true,
        isKnownGap: true,
        profileNarrativeLength: 0,
        populatedFieldCount: 0,
        fitConfidence: 'low',
        jobDescriptionLength: 10,
      });
      expect(decision.path).toBe('claude_direct');
      expect(decision.reasons).toEqual(['answered before and confirmed']);
    });
  });

  describe('gpt_then_claude — context is not clear', () => {
    it('routes a genuine knowledge gap', () => {
      const d = chooseOrchestrationPath({ ...CLEAR, isKnownGap: true });
      expect(d.path).toBe('gpt_then_claude');
      expect(d.reasons).toContain('a genuine knowledge gap');
    });

    it('routes an unreadable posting level', () => {
      const d = chooseOrchestrationPath({ ...CLEAR, fitConfidence: 'low' });
      expect(d.path).toBe('gpt_then_claude');
      expect(d.reasons).toContain('the posting’s level was unreadable');
    });

    it('routes a thin profile narrative', () => {
      const d = chooseOrchestrationPath({ ...CLEAR, profileNarrativeLength: 50 });
      expect(d.path).toBe('gpt_then_claude');
      expect(d.reasons).toContain('little written experience on file');
    });

    it('routes a profile with almost no structured fields', () => {
      const d = chooseOrchestrationPath({ ...CLEAR, populatedFieldCount: 1 });
      expect(d.path).toBe('gpt_then_claude');
    });

    it('routes a stub job description', () => {
      const d = chooseOrchestrationPath({ ...CLEAR, jobDescriptionLength: 40 });
      expect(d.path).toBe('gpt_then_claude');
      expect(d.reasons).toContain('the job description is very short');
    });

    it('reports EVERY reason, not just the first', () => {
      // The Draft row records this, and "why did it route that way" should not
      // need a re-run to answer.
      const d = chooseOrchestrationPath({
        ...CLEAR,
        isKnownGap: true,
        profileNarrativeLength: 10,
        populatedFieldCount: 0,
      });
      expect(d.reasons).toHaveLength(3);
    });
  });

  describe('boundaries', () => {
    it('is exact at the narrative threshold', () => {
      expect(
        chooseOrchestrationPath({
          ...CLEAR,
          profileNarrativeLength: THRESHOLDS.minNarrativeLength,
        }).path,
      ).toBe('claude_direct');
      expect(
        chooseOrchestrationPath({
          ...CLEAR,
          profileNarrativeLength: THRESHOLDS.minNarrativeLength - 1,
        }).path,
      ).toBe('gpt_then_claude');
    });

    it('is exact at the field-count threshold', () => {
      expect(
        chooseOrchestrationPath({
          ...CLEAR,
          populatedFieldCount: THRESHOLDS.minPopulatedFields,
        }).path,
      ).toBe('claude_direct');
      expect(
        chooseOrchestrationPath({
          ...CLEAR,
          populatedFieldCount: THRESHOLDS.minPopulatedFields - 1,
        }).path,
      ).toBe('gpt_then_claude');
    });

    it('treats medium fit confidence as clear enough', () => {
      // Only `low` means the posting could not be read at all.
      expect(chooseOrchestrationPath({ ...CLEAR, fitConfidence: 'medium' }).path).toBe(
        'claude_direct',
      );
    });
  });

  /**
   * The PRD acceptance criterion, asserted directly.
   */
  describe('determinism', () => {
    it('returns an identical decision for identical facts, every time', () => {
      const first = chooseOrchestrationPath(CLEAR);
      for (let i = 0; i < 100; i++) {
        expect(chooseOrchestrationPath(CLEAR)).toEqual(first);
      }
    });

    it('is deterministic for the thin path too, reasons included', () => {
      const facts = { ...CLEAR, isKnownGap: true, populatedFieldCount: 0 };
      const runs = Array.from({ length: 50 }, () => chooseOrchestrationPath(facts));
      expect(new Set(runs.map((r) => JSON.stringify(r))).size).toBe(1);
    });

    it('does not depend on a clock or on randomness', () => {
      // If it did, freezing time would change the answer.
      const before = chooseOrchestrationPath(CLEAR);
      jest.useFakeTimers().setSystemTime(new Date('2030-01-01'));
      expect(chooseOrchestrationPath(CLEAR)).toEqual(before);
      jest.useRealTimers();
    });

    it('depends on nothing outside its argument', () => {
      // A shallow copy must route identically — no hidden reads of globals.
      expect(chooseOrchestrationPath({ ...CLEAR })).toEqual(
        chooseOrchestrationPath(CLEAR),
      );
    });
  });
});
