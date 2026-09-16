import { isWorthShowing, validatePrep, type Evidence, type PrepProposal } from './prep-validation';

const evidence: Evidence = {
  profileFieldKeys: new Set(['current_role', 'years_experience', 'location']),
  hasNarrative: true,
  sourceUrls: new Set(['https://example.com/sky', 'https://news.example.com/sky-2026']),
};

function proposal(overrides: Partial<PrepProposal> = {}): PrepProposal {
  return {
    background: 'Sky Capital Partners is a Manchester investment firm founded in 2011.',
    backgroundSourceUrls: ['https://example.com/sky'],
    questions: [{ question: 'Why this role?', why: 'the posting stresses motivation' }],
    talkingPoints: [
      { point: 'Four years building payment systems.', basis: { kind: 'narrative' } },
    ],
    ...overrides,
  };
}

describe('validatePrep', () => {
  describe('background', () => {
    it('keeps a background that cites a real search result', () => {
      const prep = validatePrep(proposal(), evidence);
      expect(prep.background).toContain('Manchester');
      expect(prep.sources).toEqual(['https://example.com/sky']);
    });

    it('drops a background whose source was never returned by the search', () => {
      // The model writing from memory and attaching a plausible-looking URL is
      // the exact failure this exists to catch.
      const prep = validatePrep(
        proposal({ backgroundSourceUrls: ['https://invented.example.com'] }),
        evidence,
      );

      expect(prep.background).toBeNull();
      expect(prep.sources).toEqual([]);
      expect(prep.discarded.join(' ')).toContain('invented.example.com');
    });

    it('drops a background that cites nothing at all', () => {
      const prep = validatePrep(proposal({ backgroundSourceUrls: [] }), evidence);
      expect(prep.background).toBeNull();
    });

    it('accepts a null background without complaint', () => {
      // "I could not find anything about this company" is a correct answer.
      const prep = validatePrep(
        proposal({ background: null, backgroundSourceUrls: [] }),
        evidence,
      );

      expect(prep.background).toBeNull();
      expect(prep.discarded).toEqual([]);
    });

    it('keeps the verifiable sources and drops the rest', () => {
      const prep = validatePrep(
        proposal({
          backgroundSourceUrls: [
            'https://example.com/sky',
            'https://invented.example.com',
            'https://example.com/sky',
          ],
        }),
        evidence,
      );

      expect(prep.sources).toEqual(['https://example.com/sky']);
    });
  });

  describe('talking points', () => {
    it('keeps a point attributed to a profile field the Client has', () => {
      const prep = validatePrep(
        proposal({
          talkingPoints: [
            { point: 'Based in Manchester.', basis: { kind: 'profile_field', key: 'location' } },
          ],
        }),
        evidence,
      );

      expect(prep.talkingPoints).toEqual([
        { point: 'Based in Manchester.', basis: { kind: 'profile_field', key: 'location' } },
      ]);
    });

    it('drops a point citing a field the Client never filled in', () => {
      // A plausible key for a field that does not exist is the most convincing
      // kind of fabrication — it looks attributed.
      const prep = validatePrep(
        proposal({
          talkingPoints: [
            { point: 'Fluent in Mandarin.', basis: { kind: 'profile_field', key: 'languages' } },
          ],
        }),
        evidence,
      );

      expect(prep.talkingPoints).toEqual([]);
      expect(prep.discarded.join(' ')).toContain('Fluent in Mandarin');
    });

    it('drops a narrative-based point when there is no narrative', () => {
      const prep = validatePrep(proposal(), { ...evidence, hasNarrative: false });
      expect(prep.talkingPoints).toEqual([]);
    });

    it('drops a point citing a URL the search did not return', () => {
      const prep = validatePrep(
        proposal({
          talkingPoints: [
            { point: 'They just raised a round.', basis: { kind: 'source', url: 'https://x' } },
          ],
        }),
        evidence,
      );

      expect(prep.talkingPoints).toEqual([]);
    });

    it.each([
      ['no basis at all', undefined],
      ['an empty object', {}],
      ['a made-up kind', { kind: 'vibes' }],
      ['a string', 'because I said so'],
      ['a profile basis with no key', { kind: 'profile_field' }],
    ])('drops a point whose basis is %s', (_label, basis) => {
      const prep = validatePrep(
        proposal({ talkingPoints: [{ point: 'Something.', basis }] }),
        evidence,
      );
      expect(prep.talkingPoints).toEqual([]);
    });

    it('keeps the good points and drops only the bad ones', () => {
      const prep = validatePrep(
        proposal({
          talkingPoints: [
            { point: 'Real.', basis: { kind: 'narrative' } },
            { point: 'Invented.', basis: { kind: 'profile_field', key: 'nope' } },
            { point: 'Also real.', basis: { kind: 'profile_field', key: 'current_role' } },
          ],
        }),
        evidence,
      );

      expect(prep.talkingPoints.map((t) => t.point)).toEqual(['Real.', 'Also real.']);
      expect(prep.discarded).toHaveLength(1);
    });

    it('caps the list rather than passing through whatever arrives', () => {
      const many = Array.from({ length: 30 }, (_, i) => ({
        point: `Point ${i}`,
        basis: { kind: 'narrative' as const },
      }));
      expect(validatePrep(proposal({ talkingPoints: many }), evidence).talkingPoints).toHaveLength(8);
    });
  });

  describe('questions', () => {
    it('drops empty questions and caps the list', () => {
      const questions = [
        { question: '  ', why: 'blank' },
        ...Array.from({ length: 20 }, (_, i) => ({ question: `Q${i}`, why: 'because' })),
      ];
      const prep = validatePrep(proposal({ questions }), evidence);

      expect(prep.questions).toHaveLength(10);
      expect(prep.questions[0].question).toBe('Q0');
    });

    it('tolerates a missing "why" rather than dropping the question', () => {
      // The question is the useful part; the rationale is a nicety.
      const prep = validatePrep(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        proposal({ questions: [{ question: 'Why this role?' } as any] }),
        evidence,
      );
      expect(prep.questions).toEqual([{ question: 'Why this role?', why: '' }]);
    });
  });

  describe('the no-findable-company case', () => {
    it('still produces a usable document', () => {
      // PRD acceptance: degrade to questions and talking points rather than
      // fabricating background.
      const prep = validatePrep(
        proposal({ background: null, backgroundSourceUrls: [] }),
        { ...evidence, sourceUrls: new Set() },
      );

      expect(prep.background).toBeNull();
      expect(prep.questions).toHaveLength(1);
      expect(prep.talkingPoints).toHaveLength(1);
      expect(isWorthShowing(prep)).toBe(true);
    });

    it('is not worth showing when nothing survived', () => {
      const prep = validatePrep(
        { background: null, backgroundSourceUrls: [], questions: [], talkingPoints: [] },
        evidence,
      );
      expect(isWorthShowing(prep)).toBe(false);
    });
  });
});
