import {
  cosineSimilarity,
  findMatch,
  normaliseQuestion,
  SEMANTIC_THRESHOLD,
  type QaEntry,
} from './qa-matcher';

describe('normaliseQuestion', () => {
  it('collapses the differences between two askings of the same field', () => {
    expect(normaliseQuestion('What is your notice period?')).toBe(
      normaliseQuestion('what is your notice period'),
    );
  });

  it('strips form-field boilerplate', () => {
    expect(normaliseQuestion('Please tell us your notice period')).toBe(
      normaliseQuestion('your notice period'),
    );
  });

  it('strips required markers', () => {
    expect(normaliseQuestion('Notice period (required)')).toBe(
      normaliseQuestion('Notice period'),
    );
    expect(normaliseQuestion('Notice period *')).toBe(normaliseQuestion('Notice period'));
  });

  it('normalises smart quotes, which differ by job board', () => {
    expect(normaliseQuestion('What’s your notice period?')).toBe(
      normaliseQuestion("What's your notice period?"),
    );
  });

  /**
   * The restraint that matters: stemming or synonym expansion here would start
   * collapsing genuinely different questions, and that failure is invisible
   * until it has been submitted.
   */
  it('does NOT collapse genuinely different questions', () => {
    expect(normaliseQuestion('What is your notice period?')).not.toBe(
      normaliseQuestion('What is your salary expectation?'),
    );
    expect(normaliseQuestion('Why do you want this role?')).not.toBe(
      normaliseQuestion('Why did you leave your last role?'),
    );
  });

  it('handles an empty string without throwing', () => {
    expect(normaliseQuestion('')).toBe('');
  });
});

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });

  it('is 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('is -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it('ignores magnitude — direction is what carries the meaning', () => {
    expect(cosineSimilarity([1, 1], [10, 10])).toBeCloseTo(1);
  });

  it('fails closed on a zero vector rather than reporting a perfect match', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it('fails closed on mismatched dimensions', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it('fails closed on empty input', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe('findMatch', () => {
  /** Hand-built vectors: near-parallel means paraphrase, orthogonal means not. */
  const NOTICE = [1, 0, 0];
  const NOTICE_PARAPHRASE = [0.97, 0.24, 0];
  const SALARY = [0, 1, 0];

  const entries: QaEntry[] = [
    {
      id: 'q1',
      questionText: 'What is your notice period?',
      answer: 'One month',
      embedding: NOTICE,
    },
    {
      id: 'q2',
      questionText: 'What is your salary expectation?',
      answer: '55,000',
      embedding: SALARY,
    },
  ];

  describe('exact layer', () => {
    it('matches the same question worded the same way', () => {
      const match = findMatch('What is your notice period?', entries, null);
      expect(match?.entry.id).toBe('q1');
      expect(match?.strategy).toBe('exact');
      expect(match?.similarity).toBe(1);
    });

    it('matches through case, punctuation and boilerplate', () => {
      expect(
        findMatch('Please tell us: WHAT IS YOUR NOTICE PERIOD (required)', entries, null)
          ?.entry.id,
      ).toBe('q1');
    });

    it('strips the (required) marker but not the WORD required', () => {
      // "Is sponsorship required?" is a real question whose last word happens
      // to be the marker. Stripping by word rather than by markup would turn it
      // into "is sponsorship" and merge it with a different question.
      expect(normaliseQuestion('Do you need sponsorship? (required)')).toBe(
        'do you need sponsorship',
      );
      expect(normaliseQuestion('Is sponsorship required?')).toBe(
        'is sponsorship required',
      );
      expect(normaliseQuestion('Is sponsorship required? *')).toBe(
        'is sponsorship required',
      );
    });

    /** The Q&A bank keeps working when the embedding provider is down. */
    it('works with no embedding at all', () => {
      expect(findMatch('What is your notice period?', entries, null)).not.toBeNull();
    });

    it('does not match an empty question against an empty stored one', () => {
      const withEmpty: QaEntry[] = [{ id: 'x', questionText: '', answer: 'a', embedding: null }];
      expect(findMatch('', withEmpty, null)).toBeNull();
    });
  });

  describe('semantic layer', () => {
    /**
     * The PRD acceptance criterion: a resolved gap is matched on a semantically
     * different phrasing of the same question.
     */
    it('matches a paraphrase the exact layer misses', () => {
      const match = findMatch(
        'How much notice do you need to give your current employer?',
        entries,
        NOTICE_PARAPHRASE,
      );
      expect(match?.entry.id).toBe('q1');
      expect(match?.strategy).toBe('semantic');
      expect(match?.similarity).toBeGreaterThanOrEqual(SEMANTIC_THRESHOLD);
    });

    it('does not match a different question that happens to be nearby', () => {
      expect(findMatch('What salary are you after?', entries, SALARY)?.entry.id).toBe('q2');
      // ...and the notice entry is not what came back.
      expect(findMatch('What salary are you after?', entries, SALARY)?.entry.id).not.toBe(
        'q1',
      );
    });

    it('returns nothing below the threshold', () => {
      // Deliberately just under: a near miss is still a miss.
      const justUnder = [0.85, 0.53, 0];
      expect(findMatch('Something else entirely', entries, justUnder)).toBeNull();
    });

    it('picks the closest when several clear the bar', () => {
      const crowded: QaEntry[] = [
        { id: 'near', questionText: 'a', answer: 'a', embedding: [0.95, 0.31, 0] },
        { id: 'nearer', questionText: 'b', answer: 'b', embedding: [0.99, 0.14, 0] },
      ];
      expect(findMatch('q', crowded, NOTICE)?.entry.id).toBe('nearer');
    });

    it('skips entries stored before embeddings existed', () => {
      const legacy: QaEntry[] = [
        { id: 'old', questionText: 'Some old question', answer: 'x', embedding: null },
      ];
      expect(findMatch('A paraphrase of it', legacy, NOTICE)).toBeNull();
    });
  });

  describe('the threshold is tuned to miss rather than invent', () => {
    it('is high enough that loosely related questions do not match', () => {
      // A false match answers a NEW question with an OLD answer and puts
      // something untrue in a real application. A miss costs one notification.
      expect(SEMANTIC_THRESHOLD).toBeGreaterThanOrEqual(0.85);
    });

    it('can be overridden for a caller that wants to be stricter', () => {
      expect(
        findMatch('paraphrase', entries, NOTICE_PARAPHRASE, 0.99),
      ).toBeNull();
    });
  });

  it('prefers an exact match over a closer semantic one', () => {
    // If they literally asked this before, that answer is the right one however
    // similar something else looks.
    const match = findMatch('What is your notice period?', entries, SALARY);
    expect(match?.strategy).toBe('exact');
    expect(match?.entry.id).toBe('q1');
  });

  it('returns nothing for an empty bank', () => {
    expect(findMatch('Anything', [], NOTICE)).toBeNull();
  });
});
