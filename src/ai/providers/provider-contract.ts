import {
  ProviderAuthError,
  ProviderContentError,
  ProviderProtocolError,
  ProviderRateLimitError,
  ProviderUnavailableError,
} from './errors';
import { TransportFailure, type HttpTransport, type TransportRequest } from './transport';
import type { ITextGenerator } from './ai-provider.interface';

/**
 * THE CONTRACT SUITE.
 *
 * PRD §2.4: "There is one shared contract test suite that every provider
 * implementation must pass."
 *
 * This is what makes Liskov substitutability a property rather than an
 * aspiration. Every ITextGenerator returns the same result shape, reports usage
 * the same way, and — the part that actually bites in production — fails with
 * the same typed errors for the same conditions. A caller handling a rate limit
 * must not need to know which provider it is talking to.
 *
 * A new provider imports `describeTextGeneratorContract` and passes these, or
 * it does not ship.
 */

export interface ScriptedResponse {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

/** A transport that replays a script and records what it was asked to send. */
export class ScriptedTransport implements HttpTransport {
  readonly sent: TransportRequest[] = [];

  constructor(
    private readonly responses: ScriptedResponse[] = [],
    private readonly streamEvents: unknown[] = [],
    private readonly failWith?: Error,
  ) {}

  send(request: TransportRequest) {
    this.sent.push(request);
    if (this.failWith) return Promise.reject(this.failWith);
    const next = this.responses.shift();
    if (!next) throw new Error('ScriptedTransport: no response scripted');
    return Promise.resolve({
      status: next.status,
      headers: next.headers ?? {},
      body: next.body,
    });
  }

  async *stream(request: TransportRequest): AsyncIterable<unknown> {
    this.sent.push(request);
    if (this.failWith) throw this.failWith;
    for (const event of this.streamEvents) yield event;
  }
}

/** What a provider's own spec supplies so the shared suite can drive it. */
export interface ContractFixtures {
  /** Builds the provider around a transport. */
  create(transport: HttpTransport): ITextGenerator;
  /** A successful completion, in this provider's wire format. */
  successBody(text: string, inputTokens: number, outputTokens: number): unknown;
  /** Stream events that together produce "Hello world". */
  streamEvents(): unknown[];
  /** This provider's error body shape. */
  errorBody(message: string): unknown;
  /** Where the request should carry the cacheable prefix, for the caching test. */
  findCacheablePrefix(body: unknown): string | undefined;
}

/**
 * The part of the contract that is true of EVERY ITextGenerator, including ones
 * that never make an HTTP call.
 *
 * Split out from the transport half after a third provider — a local stub with
 * no network — made the distinction matter. Running "429 maps to
 * ProviderRateLimitError" against something that cannot receive a 429 would
 * test nothing; asserting the result shape and stream termination tests
 * everything a caller actually depends on.
 */
export function describeTextGeneratorCoreContract(
  name: string,
  create: () => ITextGenerator,
): void {
  describe(`${name} — core ITextGenerator semantics`, () => {
    const request = {
      maxTokens: 512,
      messages: [{ role: 'user' as const, content: 'Draft an answer.' }],
    };

    it('exposes a name', () => {
      expect(create().name).toBeTruthy();
    });

    it('returns the normalised result shape', async () => {
      const result = await create().generate(request);
      expect(typeof result.text).toBe('string');
      expect(typeof result.usage.inputTokens).toBe('number');
      expect(typeof result.usage.outputTokens).toBe('number');
      expect(typeof result.model).toBe('string');
      expect(['end', 'max_tokens', 'stop_sequence', 'refusal']).toContain(
        result.stopReason,
      );
    });

    it('streams and terminates exactly once', async () => {
      const chunks = [];
      for await (const chunk of create().stream(request)) chunks.push(chunk);

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[chunks.length - 1].done).toBe(true);
      expect(chunks.filter((c) => c.done)).toHaveLength(1);
    });

    it('streams the same text it would have generated', async () => {
      const generated = await create().generate(request);
      let streamed = '';
      for await (const chunk of create().stream(request)) streamed += chunk.delta;
      // Whitespace can differ at chunk seams; the content must not.
      expect(streamed.replace(/\s+/g, ' ').trim()).toBe(
        generated.text.replace(/\s+/g, ' ').trim(),
      );
    });
  });
}

/** Core semantics plus HTTP error normalisation. For transport-backed providers. */
export function describeTextGeneratorContract(
  name: string,
  fixtures: ContractFixtures,
): void {
  describeTextGeneratorCoreContract(name, () =>
    fixtures.create(
      new ScriptedTransport(
        Array.from({ length: 8 }, () => ({
          status: 200,
          body: fixtures.successBody('Hello world', 10, 2),
        })),
        fixtures.streamEvents(),
      ),
    ),
  );

  describe(`${name} — ITextGenerator contract`, () => {
    const request = {
      maxTokens: 512,
      messages: [{ role: 'user' as const, content: 'Draft an answer.' }],
    };

    describe('successful generation', () => {
      it('returns the completed text', async () => {
        const transport = new ScriptedTransport([
          { status: 200, body: fixtures.successBody('A drafted answer.', 100, 20) },
        ]);
        const result = await fixtures.create(transport).generate(request);
        expect(result.text).toBe('A drafted answer.');
      });

      it('reports usage in the normalised shape', async () => {
        const transport = new ScriptedTransport([
          { status: 200, body: fixtures.successBody('ok', 1234, 56) },
        ]);
        const result = await fixtures.create(transport).generate(request);
        expect(result.usage.inputTokens).toBe(1234);
        expect(result.usage.outputTokens).toBe(56);
      });

      it('reports the model it actually used', async () => {
        const transport = new ScriptedTransport([
          { status: 200, body: fixtures.successBody('ok', 1, 1) },
        ]);
        const result = await fixtures.create(transport).generate(request);
        expect(typeof result.model).toBe('string');
        expect(result.model.length).toBeGreaterThan(0);
      });

      it('reports a stop reason from the shared vocabulary', async () => {
        const transport = new ScriptedTransport([
          { status: 200, body: fixtures.successBody('ok', 1, 1) },
        ]);
        const result = await fixtures.create(transport).generate(request);
        expect(['end', 'max_tokens', 'stop_sequence', 'refusal']).toContain(
          result.stopReason,
        );
      });

      it('exposes a name', () => {
        expect(fixtures.create(new ScriptedTransport()).name).toBeTruthy();
      });
    });

    describe('error normalisation', () => {
      const failing = (status: number, headers?: Record<string, string>) =>
        fixtures
          .create(
            new ScriptedTransport([
              { status, headers, body: fixtures.errorBody('upstream said no') },
            ]),
          )
          .generate(request);

      it('429 → ProviderRateLimitError', async () => {
        await expect(failing(429)).rejects.toBeInstanceOf(ProviderRateLimitError);
      });

      it('429 carries retry-after when the provider sent one', async () => {
        await expect(failing(429, { 'retry-after': '30' })).rejects.toMatchObject({
          retryAfterSeconds: 30,
        });
      });

      it('429 is marked retryable', async () => {
        await expect(failing(429)).rejects.toMatchObject({ retryable: true });
      });

      it('401 → ProviderAuthError, not retryable', async () => {
        await expect(failing(401)).rejects.toBeInstanceOf(ProviderAuthError);
        await expect(failing(401)).rejects.toMatchObject({ retryable: false });
      });

      it('403 → ProviderAuthError', async () => {
        await expect(failing(403)).rejects.toBeInstanceOf(ProviderAuthError);
      });

      it('400 → ProviderContentError, not retryable', async () => {
        await expect(failing(400)).rejects.toBeInstanceOf(ProviderContentError);
        await expect(failing(400)).rejects.toMatchObject({ retryable: false });
      });

      it('500 → ProviderUnavailableError, retryable', async () => {
        await expect(failing(500)).rejects.toBeInstanceOf(ProviderUnavailableError);
        await expect(failing(500)).rejects.toMatchObject({ retryable: true });
      });

      it('503 → ProviderUnavailableError', async () => {
        await expect(failing(503)).rejects.toBeInstanceOf(ProviderUnavailableError);
      });

      it('a transport failure → ProviderUnavailableError, never a raw socket error', async () => {
        const transport = new ScriptedTransport(
          [],
          [],
          new TransportFailure('network request failed'),
        );
        await expect(
          fixtures.create(transport).generate(request),
        ).rejects.toBeInstanceOf(ProviderUnavailableError);
      });

      it('a malformed success body → ProviderProtocolError', async () => {
        const transport = new ScriptedTransport([{ status: 200, body: { nonsense: true } }]);
        await expect(
          fixtures.create(transport).generate(request),
        ).rejects.toBeInstanceOf(ProviderProtocolError);
      });

      it('names the provider on every error, so a log says which one failed', async () => {
        // Asserted by reading the property rather than with expect.any(String),
        // which is typed `any` and would switch off checking for the whole
        // matcher object — including the property name itself.
        const error: unknown = await failing(500).catch((e: unknown) => e);
        expect(typeof (error as { provider?: unknown }).provider).toBe('string');
      });

      it('never leaks the API key into an error message', async () => {
        const message = await failing(401).catch((e: Error) => e.message);
        expect(message).not.toContain('secret-key-value');
      });
    });

    describe('streaming', () => {
      it('yields incremental text and terminates', async () => {
        const transport = new ScriptedTransport([], fixtures.streamEvents());
        const chunks = [];
        for await (const chunk of fixtures.create(transport).stream(request)) {
          chunks.push(chunk);
        }

        expect(chunks.map((c) => c.delta).join('')).toBe('Hello world');
        expect(chunks[chunks.length - 1].done).toBe(true);
        // Exactly one terminal chunk — a consumer that stops on `done` must not
        // miss anything, and must not be told twice.
        expect(chunks.filter((c) => c.done)).toHaveLength(1);
      });

      it('maps a stream transport failure to ProviderUnavailableError too', async () => {
        const transport = new ScriptedTransport([], [], new TransportFailure('dropped'));
        const consume = async () => {
          for await (const _ of fixtures.create(transport).stream(request)) {
            // drain
          }
        };
        await expect(consume()).rejects.toBeInstanceOf(ProviderUnavailableError);
      });
    });

    describe('prompt caching', () => {
      it('places the cacheable prefix where this provider can reuse it', async () => {
        const transport = new ScriptedTransport([
          { status: 200, body: fixtures.successBody('ok', 1, 1) },
        ]);
        await fixtures.create(transport).generate({
          ...request,
          cacheablePrefix: 'STABLE PROFILE CONTEXT',
        });

        expect(fixtures.findCacheablePrefix(transport.sent[0].body)).toContain(
          'STABLE PROFILE CONTEXT',
        );
      });

      it('works without one', async () => {
        const transport = new ScriptedTransport([
          { status: 200, body: fixtures.successBody('ok', 1, 1) },
        ]);
        await expect(
          fixtures.create(transport).generate(request),
        ).resolves.toBeTruthy();
      });
    });

    describe('request construction', () => {
      it('sends the caller’s max tokens', async () => {
        const transport = new ScriptedTransport([
          { status: 200, body: fixtures.successBody('ok', 1, 1) },
        ]);
        await fixtures.create(transport).generate({ ...request, maxTokens: 777 });
        expect(JSON.stringify(transport.sent[0].body)).toContain('777');
      });

      it('authenticates', async () => {
        const transport = new ScriptedTransport([
          { status: 200, body: fixtures.successBody('ok', 1, 1) },
        ]);
        await fixtures.create(transport).generate(request);
        const headers = JSON.stringify(transport.sent[0].headers);
        expect(headers).toContain('secret-key-value');
      });
    });
  });
}
