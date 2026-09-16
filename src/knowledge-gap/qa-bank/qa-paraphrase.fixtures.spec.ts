import { findMatch, normaliseQuestion, SEMANTIC_THRESHOLD, type QaEntry } from './qa-matcher';

/**
 * PRD Phase 7 acceptance: "A resolved gap's answer is matched on a semantically
 * different phrasing of the same question — tested with a fixture set of
 * paraphrases."
 *
 * ── What this can and cannot prove ──────────────────────────────────────────
 * It cannot prove that OpenAI's embeddings place any particular pair of
 * sentences close together; that is a property of a model behind a network
 * call, and a test that asserts it is a test that fails when a vendor ships an
 * update.
 *
 * What it does prove is everything the product owns: that paraphrases which an
 * embedder DOES place together are matched, that the exact layer catches the
 * large boring majority without an embedder at all, and — the part that
 * actually matters — that questions which are RELATED BUT DIFFERENT are not
 * matched even when they sit close in the space. Answering "do you need
 * sponsorship" with the answer to "do you have the right to work here" is the
 * failure mode that puts something untrue in a real application, and the
 * fixtures below encode it as a permanent negative.
 *
 * The vectors are built by hand from named concept axes, so what each fixture
 * asserts is legible rather than a magic array of floats.
 */

// Orthogonal concept axes. A question's vector is a blend of them.
//
// `expectation` and `history` are what separate "what do you want to earn" from
// "what do you earn now" — two questions built from the same nouns. Without an
// axis for that distinction the fixtures would place them on top of each other,
// and the suite would be asserting that the matcher cannot tell apart something
// this file never described as different.
const AXES = [
  'notice',
  'sponsorship',
  'right_to_work',
  'salary',
  'relocation',
  'start_date',
  'expectation',
  'history',
] as const;
type Axis = (typeof AXES)[number];

/** Unit vector from a weighted mix of axes. */
function vector(mix: Partial<Record<Axis, number>>): number[] {
  const raw = AXES.map((axis) => mix[axis] ?? 0);
  const magnitude = Math.sqrt(raw.reduce((sum, v) => sum + v * v, 0));
  return raw.map((v) => v / magnitude);
}

/**
 * The bank: three questions the Client has answered before.
 */
const BANK: { entry: QaEntry; embedding: number[] }[] = [
  {
    entry: {
      id: 'notice',
      questionText: 'What is your notice period?',
      answer: 'One month.',
      embedding: null,
    },
    embedding: vector({ notice: 1 }),
  },
  {
    entry: {
      id: 'sponsorship',
      questionText: 'Do you require visa sponsorship?',
      answer: 'No, I do not require sponsorship.',
      embedding: null,
    },
    // Sits close to right_to_work: these are asked in the same breath and a
    // real embedder places them near each other. That is the point.
    embedding: vector({ sponsorship: 1, right_to_work: 0.55 }),
  },
  {
    entry: {
      id: 'salary',
      questionText: 'What are your salary expectations?',
      answer: '£55,000.',
      embedding: null,
    },
    embedding: vector({ salary: 1, expectation: 0.8 }),
  },
];

const entries: QaEntry[] = BANK.map((b) => ({ ...b.entry, embedding: b.embedding }));

interface Fixture {
  question: string;
  embedding: number[];
  /** The entry id that should match, or null for "must not match anything". */
  expect: string | null;
  why: string;
}

const PARAPHRASES: Fixture[] = [
  {
    question: 'How much notice do you need to give your current employer?',
    embedding: vector({ notice: 1, start_date: 0.28 }),
    expect: 'notice',
    why: 'the same question in longer words',
  },
  {
    question: 'Notice period?',
    embedding: vector({ notice: 1 }),
    expect: 'notice',
    why: 'the terse form a job board uses',
  },
  {
    question: 'Will you need sponsorship to work in the UK?',
    embedding: vector({ sponsorship: 1, right_to_work: 0.5 }),
    expect: 'sponsorship',
    why: 'same question, different wording',
  },
  {
    question: 'What salary are you looking for?',
    embedding: vector({ salary: 1, expectation: 0.75 }),
    expect: 'salary',
    why: 'same question, plainer register',
  },
];

const NEAR_MISSES: Fixture[] = [
  {
    question: 'Do you have the right to work in the UK?',
    embedding: vector({ right_to_work: 1, sponsorship: 0.55 }),
    expect: null,
    why:
      'RELATED but not the same. Someone can have the right to work and still ' +
      'need sponsorship later, and vice versa. Answering this with the ' +
      'sponsorship answer puts something untrue on a real application.',
  },
  {
    question: 'When could you start?',
    embedding: vector({ start_date: 1, notice: 0.6 }),
    expect: null,
    why:
      'a notice period implies a start date but does not state one — garden ' +
      'leave, a holiday, a house move all move it',
  },
  {
    question: 'What is your current salary?',
    embedding: vector({ salary: 1, history: 0.8 }),
    expect: null,
    why:
      'expectations are not history. In several jurisdictions asking the ' +
      'second is unlawful, and answering it unprompted is worse than unhelpful.',
  },
  {
    question: 'Are you willing to relocate?',
    embedding: vector({ relocation: 1 }),
    expect: null,
    why: 'nothing in the bank is about this',
  },
];

describe('Q&A bank — paraphrase fixtures', () => {
  describe('paraphrases match', () => {
    it.each(PARAPHRASES)('$question — $why', ({ question, embedding, expect: expected }) => {
      const match = findMatch(question, entries, embedding);
      expect(match?.entry.id).toBe(expected);
    });
  });

  describe('related-but-different questions do NOT match', () => {
    it.each(NEAR_MISSES)('$question — $why', ({ question, embedding }) => {
      expect(findMatch(question, entries, embedding)).toBeNull();
    });
  });

  it('every near miss is genuinely near, or the test proves nothing', () => {
    // A negative fixture sitting at cosine 0.1 would pass no matter how loose
    // the threshold was. These have to be close enough to be a real test.
    for (const near of NEAR_MISSES.slice(0, 3)) {
      const best = Math.max(
        ...entries.map((e) => cosine(near.embedding, e.embedding ?? [])),
      );
      expect(best).toBeGreaterThan(0.5);
      expect(best).toBeLessThan(SEMANTIC_THRESHOLD);
    }
  });

  it('catches the boring majority with no embedder at all', () => {
    // The same field on a different job board: different punctuation, same
    // words. This is most real traffic, and it costs nothing.
    const variants = [
      'What is your notice period?',
      'what is your notice period',
      'WHAT IS YOUR NOTICE PERIOD *',
      'Please tell us: what is your notice period (required)',
    ];

    for (const variant of variants) {
      expect(findMatch(variant, entries, null)?.entry.id).toBe('notice');
    }
    expect(normaliseQuestion(variants[3])).toBe('what is your notice period');
  });

  it('degrades to exact matching when the embedder is unavailable', () => {
    // A paraphrase is lost, but the bank does not break and nothing is wrong.
    const paraphrase = PARAPHRASES[0];
    expect(findMatch(paraphrase.question, entries, null)).toBeNull();
    expect(findMatch('What is your notice period?', entries, null)?.entry.id).toBe('notice');
  });
});

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  return a.reduce((sum, v, i) => sum + v * b[i], 0);
}
