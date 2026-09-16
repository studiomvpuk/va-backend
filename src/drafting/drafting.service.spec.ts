import { DraftingService } from './drafting.service';
import type { ProviderFactory } from '../ai/provider-factory';
import type { ITextGenerator } from '../ai/providers/ai-provider.interface';
import type { ContextFacts } from './orchestration-rule';

const CLEAR: ContextFacts = {
  profileNarrativeLength: 1200,
  populatedFieldCount: 8,
  qaBankHit: false,
  isKnownGap: false,
  fitConfidence: 'high',
  jobDescriptionLength: 2400,
};

const THIN: ContextFacts = { ...CLEAR, isKnownGap: true, profileNarrativeLength: 20 };

function fakeProviders(responses: Record<string, string>) {
  const calls: { provider: string; request: unknown }[] = [];

  const make = (provider: string): ITextGenerator => ({
    name: provider,
    generate: (request) => {
      calls.push({ provider, request });
      return Promise.resolve({
        text: responses[provider] ?? 'drafted text',
        usage: { inputTokens: 1, outputTokens: 1 },
        model: provider,
        stopReason: 'end' as const,
      });
    },
    async *stream() {},
  });

  return {
    factory: {
      textGenerator: (provider = 'ANTHROPIC') => Promise.resolve(make(provider)),
    } as unknown as ProviderFactory,
    calls,
  };
}

const REQUEST = {
  kind: 'SCREENING_ANSWER' as const,
  questionText: 'Why do you want to work here?',
  jobTitle: 'Marketing Coordinator',
  companyName: 'Descasio Ltd',
  jobDescription:
    'Own social media scheduling and produce monthly reporting dashboards for ' +
    'stakeholder review across the marketing team.',
  profileContext: 'Twelve years leading marketing teams.',
  seniorityDirective: 'De-emphasise leadership scope and total years.',
  facts: CLEAR,
};

describe('DraftingService', () => {
  describe('claude_direct — clear context', () => {
    it('calls Anthropic once and nothing else', async () => {
      const { factory, calls } = fakeProviders({});
      await new DraftingService(factory).draft(REQUEST);

      expect(calls).toHaveLength(1);
      expect(calls[0].provider).toBe('ANTHROPIC');
    });

    it('records the path it took', async () => {
      const { factory } = fakeProviders({});
      const result = await new DraftingService(factory).draft(REQUEST);
      expect(result.orchestrationPath).toBe('claude_direct');
      expect(result.routingReasons).toEqual(['profile covers this']);
    });
  });

  describe('gpt_then_claude — thin context', () => {
    it('calls OpenAI first, then Anthropic', async () => {
      const { factory, calls } = fakeProviders({
        OPENAI: 'first pass from gpt',
        ANTHROPIC: 'refined answer',
      });
      await new DraftingService(factory).draft({ ...REQUEST, facts: THIN });

      expect(calls.map((c) => c.provider)).toEqual(['OPENAI', 'ANTHROPIC']);
    });

    it('hands the first draft to the refiner', async () => {
      const { factory, calls } = fakeProviders({
        OPENAI: 'first pass from gpt',
        ANTHROPIC: 'refined answer',
      });
      await new DraftingService(factory).draft({ ...REQUEST, facts: THIN });

      expect(JSON.stringify(calls[1].request)).toContain('first pass from gpt');
    });

    it('asks the refiner to check claims, not just tidy prose', async () => {
      // A model working from thin context fills gaps plausibly, and
      // plausible-but-untrue is what this second call exists to catch.
      const { factory, calls } = fakeProviders({ OPENAI: 'x', ANTHROPIC: 'y' });
      await new DraftingService(factory).draft({ ...REQUEST, facts: THIN });

      const refinerPrompt = JSON.stringify(calls[1].request);
      expect(refinerPrompt).toMatch(/check every claim against/i);
      expect(refinerPrompt).toMatch(/remove anything the profile does not/i);
    });

    it('returns only the refined text, never both drafts', async () => {
      // "The VA gets one finished answer."
      const { factory } = fakeProviders({
        OPENAI: 'FIRST DRAFT CONTENT',
        ANTHROPIC: 'the finished answer',
      });
      const result = await new DraftingService(factory).draft({ ...REQUEST, facts: THIN });

      expect(result.body).toBe('the finished answer');
      expect(result.body).not.toContain('FIRST DRAFT CONTENT');
    });
  });

  describe('the seniority directive', () => {
    it('reaches the model verbatim', async () => {
      const { factory, calls } = fakeProviders({});
      await new DraftingService(factory).draft(REQUEST);
      expect(JSON.stringify(calls[0].request)).toContain(
        'De-emphasise leadership scope and total years.',
      );
    });

    it('is appended to the prompt rather than replacing it', async () => {
      const { factory, calls } = fakeProviders({});
      await new DraftingService(factory).draft(REQUEST);
      const system = (calls[0].request as { system: string }).system;
      // Keeping the shared prompt stable is what makes its version meaningful.
      expect(system).toContain('ATS');
      expect(system).toContain('SENIORITY CALIBRATION FOR THIS APPLICATION');
    });
  });

  describe('the ATS pass is not advisory', () => {
    it('strips filler the model produced anyway', async () => {
      const { factory } = fakeProviders({
        ANTHROPIC: 'I am drawn to your reporting work. I hope this helps!',
      });
      const result = await new DraftingService(factory).draft(REQUEST);

      expect(result.body).not.toMatch(/I hope this helps/);
      expect(result.body).toContain('drawn to your reporting work');
    });

    it('reports the finding even though it cleaned it', async () => {
      const { factory } = fakeProviders({ ANTHROPIC: 'A team player. Did reporting.' });
      const result = await new DraftingService(factory).draft(REQUEST);

      expect(result.ats.findings.some((f) => f.code === 'filler')).toBe(true);
      expect(result.body).not.toMatch(/team player/i);
    });

    it('scores keyword alignment against the posting', async () => {
      const { factory } = fakeProviders({
        ANTHROPIC: 'I ran social media scheduling and monthly reporting dashboards.',
      });
      const result = await new DraftingService(factory).draft(REQUEST);
      expect(result.ats.keywordAlignment).toBeGreaterThan(0.2);
    });
  });

  it('wraps both the posting and the question as untrusted input', async () => {
    const { factory, calls } = fakeProviders({});
    await new DraftingService(factory).draft(REQUEST);

    const prompt = JSON.stringify(calls[0].request);
    expect(prompt).toMatch(/untrusted_input source=\\?"job_description/);
    expect(prompt).toMatch(/untrusted_input source=\\?"screening_question/);
  });

  it('caches the profile context rather than the posting', async () => {
    const { factory, calls } = fakeProviders({});
    await new DraftingService(factory).draft(REQUEST);

    const request = calls[0].request as { cacheablePrefix?: string };
    expect(request.cacheablePrefix).toBe('Twelve years leading marketing teams.');
  });

  it('records the prompt version for reproducibility', async () => {
    const { factory } = fakeProviders({});
    const result = await new DraftingService(factory).draft(REQUEST);
    expect(result.promptVersion).toBe('draft.screening_answer@1.0.0');
  });

  it.each([
    ['CV', 'draft.cv@1.0.0'],
    ['COVER_LETTER', 'draft.cover_letter@1.0.0'],
    ['SCREENING_ANSWER', 'draft.screening_answer@1.0.0'],
  ] as const)('uses the right prompt for %s', async (kind, version) => {
    const { factory } = fakeProviders({});
    const result = await new DraftingService(factory).draft({ ...REQUEST, kind });
    expect(result.promptVersion).toBe(version);
  });
});
