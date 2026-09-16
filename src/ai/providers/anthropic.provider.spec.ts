import { AnthropicProvider } from './anthropic.provider';
import {
  ScriptedTransport,
  describeTextGeneratorContract,
} from './provider-contract';
import type { HttpTransport } from './transport';

/**
 * The shared suite, plus the handful of assertions that are specific to this
 * provider's wire format. If a change here breaks substitutability, the shared
 * half fails; if it breaks Anthropic's own protocol, the specific half does.
 */
describeTextGeneratorContract('AnthropicProvider', {
  create: (transport: HttpTransport) =>
    new AnthropicProvider(transport, 'secret-key-value'),

  successBody: (text, inputTokens, outputTokens) => ({
    content: [{ type: 'text', text }],
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    model: 'claude-sonnet-4-5',
    stop_reason: 'end_turn',
  }),

  streamEvents: () => [
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: ' world' } },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { input_tokens: 10, output_tokens: 2 },
    },
  ],

  errorBody: (message) => ({ type: 'error', error: { type: 'api_error', message } }),

  findCacheablePrefix: (body) => {
    const system = (body as { system?: { text?: string }[] }).system;
    return system?.map((s) => s.text ?? '').join('\n');
  },
});

describe('AnthropicProvider — wire format', () => {
  const transport = (body: unknown) => new ScriptedTransport(
    Array.from({ length: 4 }, () => ({ status: 200, body })),
  );

  const ok = {
    content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: 1, output_tokens: 1 },
    model: 'claude-sonnet-4-5',
    stop_reason: 'end_turn',
  };

  it('sets a cache_control breakpoint at the end of the stable prefix', async () => {
    const t = transport(ok);
    await new AnthropicProvider(t, 'k').generate({
      maxTokens: 10,
      messages: [{ role: 'user', content: 'hi' }],
      cacheablePrefix: 'PROFILE',
      system: 'STYLE GUIDE',
    });

    const body = t.sent[0].body as { system: { text: string; cache_control?: unknown }[] };
    // The breakpoint marks the end of what is reused; everything after it
    // varies per request and must not be inside the cached span.
    expect(body.system[0].text).toBe('PROFILE');
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.system[1].text).toBe('STYLE GUIDE');
    expect(body.system[1].cache_control).toBeUndefined();
  });

  it('reports cache hits when the provider does', async () => {
    const t = transport({ ...ok, usage: { ...ok.usage, cache_read_input_tokens: 900 } });
    const result = await new AnthropicProvider(
      t,
      'k',
    ).generate({ maxTokens: 10, messages: [{ role: 'user', content: 'hi' }] });

    expect(result.usage.cachedInputTokens).toBe(900);
  });

  it('sends an image as a base64 source block', async () => {
    const t = transport(ok);
    await new AnthropicProvider(t, 'k').extractText({
      image: { type: 'image', data: 'AAAA', mediaType: 'image/png' },
    });

    expect(JSON.stringify(t.sent[0].body)).toContain('"media_type":"image/png"');
  });

  it('treats 529 (overloaded) as unavailable rather than a protocol error', async () => {
    const t = new ScriptedTransport([
      { status: 529, body: { error: { message: 'overloaded' } } },
    ]);
    await expect(
      new AnthropicProvider(t, 'k').generate({
        maxTokens: 10,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toMatchObject({ kind: 'unavailable', retryable: true });
  });
});
