import { OpenAiProvider } from './openai.provider';
import {
  ScriptedTransport,
  describeTextGeneratorContract,
} from './provider-contract';
import type { HttpTransport } from './transport';

describeTextGeneratorContract('OpenAiProvider', {
  create: (transport: HttpTransport) => new OpenAiProvider(transport, 'secret-key-value'),

  successBody: (text, inputTokens, outputTokens) => ({
    choices: [{ message: { content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens },
    model: 'gpt-4.1',
  }),

  streamEvents: () => [
    { choices: [{ delta: { content: 'Hello' } }] },
    { choices: [{ delta: { content: ' world' } }] },
    {
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    },
  ],

  errorBody: (message) => ({ error: { message, type: 'invalid_request_error' } }),

  findCacheablePrefix: (body) => {
    const messages = (body as { messages?: { content?: string }[] }).messages;
    return messages?.map((m) => m.content ?? '').join('\n');
  },
});

describe('OpenAiProvider — wire format', () => {
  const transport = (body: unknown) => new ScriptedTransport(
    Array.from({ length: 4 }, () => ({ status: 200, body })),
  );

  const ok = {
    choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
    model: 'gpt-4.1',
  };

  it('puts the cacheable prefix FIRST, which is the whole optimisation here', async () => {
    const t = transport(ok);
    await new OpenAiProvider(t, 'k').generate({
      maxTokens: 10,
      messages: [{ role: 'user', content: 'hi' }],
      cacheablePrefix: 'PROFILE',
      system: 'STYLE GUIDE',
    });

    const body = t.sent[0].body as { messages: { role: string; content: string }[] };
    // OpenAI caches long prefixes automatically rather than on a marker, so
    // ordering is the requirement: stable part first, varying part after.
    expect(body.messages[0]).toEqual({ role: 'system', content: 'PROFILE' });
    expect(body.messages[1]).toEqual({ role: 'system', content: 'STYLE GUIDE' });
  });

  it('reports cache hits from prompt_tokens_details', async () => {
    const t = transport({
      ...ok,
      usage: { ...ok.usage, prompt_tokens_details: { cached_tokens: 512 } },
    });
    const result = await new OpenAiProvider(t, 'k').generate({
      maxTokens: 10,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.usage.cachedInputTokens).toBe(512);
  });

  it('maps finish_reason "length" to the shared max_tokens vocabulary', async () => {
    const t = transport({
      ...ok,
      choices: [{ message: { content: 'cut' }, finish_reason: 'length' }],
    });
    const result = await new OpenAiProvider(t, 'k').generate({
      maxTokens: 10,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.stopReason).toBe('max_tokens');
  });

  it('maps content_filter to refusal', async () => {
    const t = transport({
      ...ok,
      choices: [{ message: { content: '' }, finish_reason: 'content_filter' }],
    });
    const result = await new OpenAiProvider(t, 'k').generate({
      maxTokens: 10,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.stopReason).toBe('refusal');
  });

  it('sends an image as a data URL', async () => {
    const t = transport(ok);
    await new OpenAiProvider(t, 'k').extractText({
      image: { type: 'image', data: 'AAAA', mediaType: 'image/png' },
    });
    expect(JSON.stringify(t.sent[0].body)).toContain('data:image/png;base64,AAAA');
  });

  describe('embeddings', () => {
    const vector = (fill: number) => new Array<number>(1536).fill(fill);

    it('returns one vector per input', async () => {
      const t = transport({
        data: [
          { index: 0, embedding: vector(0.1) },
          { index: 1, embedding: vector(0.2) },
        ],
        usage: { prompt_tokens: 12 },
      });

      const result = await new OpenAiProvider(t, 'k').embed({ texts: ['a', 'b'] });

      expect(result.vectors).toHaveLength(2);
      expect(result.vectors[0][0]).toBe(0.1);
      expect(result.usage.inputTokens).toBe(12);
    });

    it('reorders by index rather than trusting the response order', async () => {
      // The API does not promise order. Trusting it would attach the wrong
      // vector to the wrong question, and the bank would then answer a new
      // question with an old answer.
      const t = transport({
        data: [
          { index: 1, embedding: vector(0.2) },
          { index: 0, embedding: vector(0.1) },
        ],
        usage: { prompt_tokens: 12 },
      });

      const result = await new OpenAiProvider(t, 'k').embed({ texts: ['first', 'second'] });

      expect(result.vectors[0][0]).toBe(0.1);
      expect(result.vectors[1][0]).toBe(0.2);
    });

    it('rejects a response with the wrong number of embeddings', async () => {
      const t = transport({ data: [{ index: 0, embedding: vector(0.1) }] });
      await expect(
        new OpenAiProvider(t, 'k').embed({ texts: ['a', 'b'] }),
      ).rejects.toThrow(/expected 2 embeddings/);
    });

    it('rejects a vector of the wrong width', async () => {
      const t = transport({ data: [{ index: 0, embedding: [1, 2, 3] }] });
      await expect(
        new OpenAiProvider(t, 'k').embed({ texts: ['a'] }),
      ).rejects.toThrow(/wrong width/);
    });

    it('rejects duplicate indexes rather than silently dropping one', async () => {
      const t = transport({
        data: [
          { index: 0, embedding: vector(0.1) },
          { index: 0, embedding: vector(0.2) },
        ],
      });
      await expect(
        new OpenAiProvider(t, 'k').embed({ texts: ['a', 'b'] }),
      ).rejects.toThrow(/duplicate index/);
    });

    it('makes no call at all for an empty batch', async () => {
      const t = new ScriptedTransport([]);
      const result = await new OpenAiProvider(t, 'k').embed({ texts: [] });
      expect(result.vectors).toEqual([]);
      expect(t.sent).toHaveLength(0);
    });

    it('asks for the width the column expects', async () => {
      const t = transport({ data: [{ index: 0, embedding: vector(0.1) }] });
      await new OpenAiProvider(t, 'k').embed({ texts: ['a'] });
      expect(JSON.stringify(t.sent[0].body)).toContain('"dimensions":1536');
      expect(t.sent[0].url).toContain('/v1/embeddings');
    });
  });
});
