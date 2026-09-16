import {
  formatResults,
  parseProposal,
  PrepComposer,
  PrepCompositionError,
} from './prep-composer';
import type { ISearchProvider, SearchResult } from '../ai/providers/ai-provider.interface';
import type { ProviderFactory } from '../ai/provider-factory';

const RESULT: SearchResult = {
  title: 'Sky Capital Partners',
  url: 'https://example.com/sky',
  snippet: 'A Manchester investment firm founded in 2011.',
};

class FakeSearch implements ISearchProvider {
  readonly name = 'fake';
  readonly queries: string[] = [];

  constructor(
    private readonly results: SearchResult[] = [RESULT],
    private readonly failWith?: Error,
  ) {}

  search(input: { query: string }): Promise<SearchResult[]> {
    this.queries.push(input.query);
    if (this.failWith) return Promise.reject(this.failWith);
    return Promise.resolve(this.results);
  }
}

function factoryReturning(text: string) {
  const prompts: string[] = [];
  const factory = {
    textGenerator: () =>
      Promise.resolve({
        name: 'fake',
        generate: (request: { messages: { content: string }[] }) => {
          prompts.push(request.messages[0].content);
          return Promise.resolve({
            text,
            usage: { inputTokens: 1, outputTokens: 1 },
            model: 'fake',
            stopReason: 'end' as const,
          });
        },
        stream: () => {
          throw new Error('not used');
        },
      }),
  } as unknown as ProviderFactory;
  return { factory, prompts };
}

const GOOD = JSON.stringify({
  background: 'A Manchester investment firm founded in 2011.',
  backgroundSourceUrls: ['https://example.com/sky'],
  questions: [{ question: 'Why this role?', why: 'the posting stresses motivation' }],
  talkingPoints: [
    { point: 'Four years on payment systems.', basis: { kind: 'narrative' } },
    { point: 'They are Manchester-based.', basis: { kind: 'source', url: 'https://example.com/sky' } },
  ],
});

const input = {
  companyName: 'Sky Capital Partners',
  roleTitle: 'Operations Lead',
  jobDescription: 'A posting.',
  profileContext: 'profile',
  profileFieldKeys: ['location'],
  hasNarrative: true,
};

describe('PrepComposer', () => {
  it('composes a document from the search results', async () => {
    const { factory } = factoryReturning(GOOD);
    const prep = await new PrepComposer(factory, new FakeSearch()).compose(input);

    expect(prep.background).toContain('Manchester');
    expect(prep.sources).toEqual(['https://example.com/sky']);
    expect(prep.talkingPoints).toHaveLength(2);
  });

  it('searches for the company and for the company-plus-role', async () => {
    // One query gets the homepage or gets what is said about working there,
    // and which one depends on how generic the name is.
    const search = new FakeSearch();
    const { factory } = factoryReturning(GOOD);
    await new PrepComposer(factory, search).compose(input);

    expect(search.queries).toEqual([
      'Sky Capital Partners',
      'Sky Capital Partners Operations Lead company',
    ]);
  });

  it('deduplicates results that both queries returned', async () => {
    const { factory, prompts } = factoryReturning(GOOD);
    await new PrepComposer(factory, new FakeSearch([RESULT, RESULT])).compose(input);

    const occurrences = prompts[0].split('https://example.com/sky').length - 1;
    expect(occurrences).toBe(1);
  });

  it('discards a background the search never supported', async () => {
    const invented = JSON.stringify({
      background: 'Founded in 1962 by two brothers in Leeds.',
      backgroundSourceUrls: ['https://made-up.example.com'],
      questions: [{ question: 'Why us?', why: 'always asked' }],
      talkingPoints: [],
    });
    const { factory } = factoryReturning(invented);

    const prep = await new PrepComposer(factory, new FakeSearch()).compose(input);

    expect(prep.background).toBeNull();
    // The questions survive — they come from the posting, not the search.
    expect(prep.questions).toHaveLength(1);
  });

  describe('when the company cannot be found', () => {
    const empty = JSON.stringify({
      background: null,
      backgroundSourceUrls: [],
      questions: [{ question: 'Why this role?', why: 'the posting stresses motivation' }],
      talkingPoints: [{ point: 'Four years on payment systems.', basis: { kind: 'narrative' } }],
    });

    it('still produces questions and talking points', async () => {
      const { factory } = factoryReturning(empty);
      const prep = await new PrepComposer(factory, new FakeSearch([])).compose(input);

      expect(prep.background).toBeNull();
      expect(prep.questions).toHaveLength(1);
      expect(prep.talkingPoints).toHaveLength(1);
    });

    it('tells the model there is nothing rather than leaving a blank', async () => {
      // An empty section reads as "omitted" and invites the model to fill it in.
      const { factory, prompts } = factoryReturning(empty);
      await new PrepComposer(factory, new FakeSearch([])).compose(input);

      expect(prompts[0]).toContain('No search results were found');
    });

    it('treats a failing search as the same case, not as a failure', async () => {
      const { factory } = factoryReturning(empty);
      const search = new FakeSearch([], new Error('search is down'));

      const prep = await new PrepComposer(factory, search).compose(input);
      expect(prep.questions).toHaveLength(1);
    });
  });

  it('wraps the posting and the results as untrusted input', async () => {
    const { factory, prompts } = factoryReturning(GOOD);
    await new PrepComposer(factory, new FakeSearch()).compose(input);

    expect(prompts[0]).toMatch(/untrusted_input source=\\?"job_description/);
    expect(prompts[0]).toMatch(/untrusted_input source=\\?"search_results/);
  });

  it('tells the model which field keys it may cite', async () => {
    const { factory, prompts } = factoryReturning(GOOD);
    await new PrepComposer(factory, new FakeSearch()).compose(input);
    expect(prompts[0]).toContain('location');
  });
});

describe('formatResults', () => {
  it('says so explicitly when there is nothing', () => {
    expect(formatResults([])).toContain('No search results were found');
  });

  it('puts the url first, because that is what gets cited', () => {
    expect(formatResults([RESULT]).startsWith('url: https://example.com/sky')).toBe(true);
  });
});

describe('parseProposal', () => {
  it('digs the JSON out of prose and fences', () => {
    const raw = `Here you go:\n\`\`\`json\n${GOOD}\n\`\`\``;
    expect(parseProposal(raw).background).toContain('Manchester');
  });

  it.each([
    ['prose with no JSON', 'I could not find anything.'],
    ['malformed JSON', '{"background": "x",'],
  ])('throws on %s', (_label, raw) => {
    expect(() => parseProposal(raw)).toThrow(PrepCompositionError);
  });

  it('defaults missing arrays to empty rather than undefined', () => {
    const parsed = parseProposal('{"background": null}');
    expect(parsed).toEqual({
      background: null,
      backgroundSourceUrls: [],
      questions: [],
      talkingPoints: [],
    });
  });

  it('drops non-string entries from the source list', () => {
    expect(
      parseProposal('{"backgroundSourceUrls": ["https://a", 7, null]}').backgroundSourceUrls,
    ).toEqual(['https://a']);
  });
});
