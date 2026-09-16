import {
  ProviderAuthError,
  ProviderContentError,
  ProviderProtocolError,
  ProviderRateLimitError,
  ProviderUnavailableError,
} from './errors';
import { TransportFailure, type HttpTransport } from './transport';
import type {
  GenerationChunk,
  GenerationRequest,
  GenerationResult,
  ImagePart,
  ITextGenerator,
  IVisionExtractor,
  Message,
  StopReason,
  TokenUsage,
} from './ai-provider.interface';

const API = 'https://api.anthropic.com/v1/messages';
const VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-4-5';

/**
 * Anthropic. Implements text generation and vision.
 *
 * Not the SDK: the transport seam is what lets the shared contract suite run
 * against this class without a network or a mocked module, and an SDK would put
 * its own error types back in the way of the normalised ones.
 *
 * `cacheablePrefix` becomes a cache_control breakpoint. In this product that
 * prefix is the Client's profile — identical on every application they make, so
 * caching it is the single biggest lever on both cost and latency (PRD §9).
 */
export class AnthropicProvider implements ITextGenerator, IVisionExtractor {
  readonly name = 'anthropic';

  constructor(
    private readonly transport: HttpTransport,
    private readonly apiKey: string,
    private readonly defaultModel = DEFAULT_MODEL,
  ) {}

  async generate(request: GenerationRequest): Promise<GenerationResult> {
    const response = await this.post(this.buildBody(request, false), request.signal);
    return this.parseResult(response);
  }

  async *stream(request: GenerationRequest): AsyncIterable<GenerationChunk> {
    let usage: TokenUsage | undefined;
    let stopReason: StopReason | undefined;

    try {
      for await (const event of this.transport.stream({
        url: API,
        method: 'POST',
        headers: this.headers(),
        body: this.buildBody(request, true),
        signal: request.signal,
      })) {
        const e = event as AnthropicStreamEvent;

        if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
          yield { delta: e.delta.text ?? '', done: false };
        }
        if (e.type === 'message_delta') {
          if (e.delta?.stop_reason) stopReason = mapStopReason(e.delta.stop_reason);
          if (e.usage) usage = mapUsage(e.usage);
        }
        if (e.type === 'error') {
          throw new ProviderUnavailableError(
            this.name,
            e.error?.message ?? 'stream error',
          );
        }
      }
    } catch (e) {
      if (e instanceof TransportFailure) {
        throw new ProviderUnavailableError(this.name, e.message, e);
      }
      throw e;
    }

    yield { delta: '', done: true, usage, stopReason };
  }

  async extractText(input: {
    image: ImagePart;
    instruction?: string;
    signal?: AbortSignal;
  }): Promise<{ text: string; usage: TokenUsage }> {
    const result = await this.generate({
      maxTokens: 4096,
      signal: input.signal,
      messages: [
        {
          role: 'user',
          content: [
            input.image,
            {
              type: 'text',
              text:
                input.instruction ??
                'Transcribe all text in this image exactly as it appears. Return ' +
                  'only the text, with no commentary.',
            },
          ],
        },
      ],
    });
    return { text: result.text, usage: result.usage };
  }

  // ───────────────────────────────────────────────────────────── internals

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': VERSION,
    };
  }

  private buildBody(request: GenerationRequest, stream: boolean): unknown {
    const system: unknown[] = [];
    if (request.cacheablePrefix) {
      // The cache breakpoint goes at the END of the stable part, so everything
      // before it is reused and everything after varies per request.
      system.push({
        type: 'text',
        text: request.cacheablePrefix,
        cache_control: { type: 'ephemeral' },
      });
    }
    if (request.system) system.push({ type: 'text', text: request.system });

    return {
      model: request.model ?? this.defaultModel,
      max_tokens: request.maxTokens,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(system.length ? { system } : {}),
      messages: request.messages.map(toAnthropicMessage),
      ...(stream ? { stream: true } : {}),
    };
  }

  private async post(body: unknown, signal?: AbortSignal): Promise<unknown> {
    let response;
    try {
      response = await this.transport.send({
        url: API,
        method: 'POST',
        headers: this.headers(),
        body,
        signal,
      });
    } catch (e) {
      if (e instanceof TransportFailure) {
        throw new ProviderUnavailableError(this.name, e.message, e);
      }
      throw e;
    }

    if (response.status >= 200 && response.status < 300) return response.body;
    throw this.mapError(response.status, response.headers, response.body);
  }

  private mapError(
    status: number,
    headers: Record<string, string>,
    body: unknown,
  ): Error {
    const detail = errorMessage(body);

    if (status === 429) {
      const retryAfter = Number(headers['retry-after']);
      return new ProviderRateLimitError(
        this.name,
        Number.isFinite(retryAfter) ? retryAfter : undefined,
        body,
      );
    }
    if (status === 401 || status === 403) return new ProviderAuthError(this.name, body);
    if (status === 400) return new ProviderContentError(this.name, detail, body);
    if (status === 529 || status >= 500) {
      return new ProviderUnavailableError(this.name, detail, body);
    }
    return new ProviderProtocolError(this.name, `HTTP ${status}: ${detail}`, body);
  }

  private parseResult(body: unknown): GenerationResult {
    const message = body as AnthropicMessage;
    const blocks = message?.content;
    if (!Array.isArray(blocks)) {
      throw new ProviderProtocolError(this.name, 'no content blocks in response', body);
    }

    return {
      text: blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join(''),
      usage: mapUsage(message.usage),
      model: message.model ?? this.defaultModel,
      stopReason: mapStopReason(message.stop_reason),
    };
  }
}

// ── wire shapes ────────────────────────────────────────────────────────────

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
}
interface AnthropicMessage {
  content?: { type: string; text?: string }[];
  usage?: AnthropicUsage;
  model?: string;
  stop_reason?: string;
}
interface AnthropicStreamEvent {
  type: string;
  delta?: { type?: string; text?: string; stop_reason?: string };
  usage?: AnthropicUsage;
  error?: { message?: string };
}

function mapUsage(usage?: AnthropicUsage): TokenUsage {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    ...(usage?.cache_read_input_tokens !== undefined
      ? { cachedInputTokens: usage.cache_read_input_tokens }
      : {}),
  };
}

function mapStopReason(reason?: string): StopReason {
  switch (reason) {
    case 'max_tokens':
      return 'max_tokens';
    case 'stop_sequence':
      return 'stop_sequence';
    case 'refusal':
      return 'refusal';
    default:
      return 'end';
  }
}

function toAnthropicMessage(message: Message): unknown {
  if (typeof message.content === 'string') return message;
  return {
    role: message.role,
    content: message.content.map((part) =>
      part.type === 'image'
        ? {
            type: 'image',
            source: { type: 'base64', media_type: part.mediaType, data: part.data },
          }
        : part,
    ),
  };
}

function errorMessage(body: unknown): string {
  const e = body as { error?: { message?: string } };
  if (typeof e?.error?.message === 'string') return e.error.message;
  return typeof body === 'string' ? body.slice(0, 200) : 'no detail';
}
