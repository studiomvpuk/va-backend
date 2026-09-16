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
  IEmbedder,
  ITextGenerator,
  ITranscriber,
  IVisionExtractor,
  Message,
  StopReason,
  TokenUsage,
} from './ai-provider.interface';

const CHAT_API = 'https://api.openai.com/v1/chat/completions';
const AUDIO_API = 'https://api.openai.com/v1/audio/transcriptions';
const EMBEDDINGS_API = 'https://api.openai.com/v1/embeddings';
const DEFAULT_MODEL = 'gpt-4.1';
const TRANSCRIBE_MODEL = 'whisper-1';
const EMBEDDING_MODEL = 'text-embedding-3-small';
// Matches `vector(1536)` in schema.prisma. Changing one without the other is a
// migration, not a config tweak — see the dimensions check in QaBankService.
const EMBEDDING_DIMENSIONS = 1536;

/**
 * OpenAI. Text, vision and transcription.
 *
 * This is the class that justifies splitting the interfaces: it implements all
 * three, while Anthropic implements two. A single `IAiProvider` would have
 * forced a `transcribe` on Anthropic that throws — and a method that throws
 * where the interface promises a result is precisely the substitutability
 * failure the contract suite exists to catch.
 *
 * `cacheablePrefix` is honoured by prepending it as the first system message.
 * OpenAI caches long prompt prefixes automatically rather than on an explicit
 * breakpoint, so putting the stable part first is the whole requirement.
 */
export class OpenAiProvider
  implements ITextGenerator, IVisionExtractor, ITranscriber, IEmbedder
{
  readonly name = 'openai';
  readonly embeddingModel = EMBEDDING_MODEL;
  readonly dimensions = EMBEDDING_DIMENSIONS;

  constructor(
    private readonly transport: HttpTransport,
    private readonly apiKey: string,
    private readonly defaultModel = DEFAULT_MODEL,
  ) {}

  async generate(request: GenerationRequest): Promise<GenerationResult> {
    const body = await this.post(this.buildBody(request, false), request.signal);
    return this.parseResult(body);
  }

  async *stream(request: GenerationRequest): AsyncIterable<GenerationChunk> {
    let usage: TokenUsage | undefined;
    let stopReason: StopReason | undefined;

    try {
      for await (const event of this.transport.stream({
        url: CHAT_API,
        method: 'POST',
        headers: this.headers(),
        body: this.buildBody(request, true),
        signal: request.signal,
      })) {
        const chunk = event as OpenAiStreamChunk;
        const choice = chunk.choices?.[0];

        if (choice?.delta?.content) {
          yield { delta: choice.delta.content, done: false };
        }
        if (choice?.finish_reason) stopReason = mapStopReason(choice.finish_reason);
        if (chunk.usage) usage = mapUsage(chunk.usage);
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

  async transcribe(input: {
    audio: Buffer;
    mediaType: string;
    signal?: AbortSignal;
  }): Promise<{ text: string }> {
    // multipart/form-data rather than JSON — the one route here that is not a
    // chat completion.
    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(input.audio)], { type: input.mediaType }),
      'audio',
    );
    form.append('model', TRANSCRIBE_MODEL);

    const body = await this.post(form, input.signal, AUDIO_API);
    const parsed = body as { text?: string };
    if (typeof parsed?.text !== 'string') {
      throw new ProviderProtocolError(this.name, 'no text in transcription response', body);
    }
    return { text: parsed.text };
  }

  /**
   * One call for the whole batch. The response is NOT guaranteed to come back
   * in request order — each item carries its own `index` — so this reorders
   * rather than trusting the array. Getting that wrong would attach the wrong
   * vector to the wrong question, and the bank would then confidently return
   * the wrong answer, which is the worst failure this product has.
   */
  async embed(input: {
    texts: string[];
    signal?: AbortSignal;
  }): Promise<{ vectors: number[][]; usage: TokenUsage }> {
    if (input.texts.length === 0) return { vectors: [], usage: { inputTokens: 0, outputTokens: 0 } };

    const body = await this.post(
      {
        model: EMBEDDING_MODEL,
        dimensions: EMBEDDING_DIMENSIONS,
        input: input.texts,
      },
      input.signal,
      EMBEDDINGS_API,
    );

    const parsed = body as OpenAiEmbeddings;
    const data = parsed?.data;
    if (!Array.isArray(data) || data.length !== input.texts.length) {
      throw new ProviderProtocolError(
        this.name,
        `expected ${input.texts.length} embeddings, got ${Array.isArray(data) ? data.length : 'none'}`,
        body,
      );
    }

    // Filled with null rather than left sparse: `Array.prototype.some` skips
    // holes, so a sparse array made the duplicate-index check below a no-op.
    const vectors: (number[] | null)[] = new Array<number[] | null>(
      input.texts.length,
    ).fill(null);
    for (const item of data) {
      const vector = item?.embedding;
      if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSIONS) {
        throw new ProviderProtocolError(
          this.name,
          `embedding has wrong width: expected ${EMBEDDING_DIMENSIONS}`,
          body,
        );
      }
      if (typeof item.index !== 'number' || item.index < 0 || item.index >= vectors.length) {
        throw new ProviderProtocolError(this.name, 'embedding has no usable index', body);
      }
      vectors[item.index] = vector;
    }
    if (vectors.some((v) => v === null)) {
      throw new ProviderProtocolError(this.name, 'duplicate index in embeddings response', body);
    }

    return {
      vectors: vectors as number[][],
      usage: {
        inputTokens: parsed.usage?.prompt_tokens ?? 0,
        outputTokens: 0,
      },
    };
  }

  // ───────────────────────────────────────────────────────────── internals

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${this.apiKey}`,
    };
  }

  private buildBody(request: GenerationRequest, stream: boolean): unknown {
    const messages: unknown[] = [];

    // Stable part first: OpenAI caches long prefixes automatically, so ordering
    // is the entire optimisation.
    if (request.cacheablePrefix) {
      messages.push({ role: 'system', content: request.cacheablePrefix });
    }
    if (request.system) messages.push({ role: 'system', content: request.system });
    messages.push(...request.messages.map(toOpenAiMessage));

    return {
      model: request.model ?? this.defaultModel,
      max_completion_tokens: request.maxTokens,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      messages,
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    };
  }

  private async post(
    body: unknown,
    signal?: AbortSignal,
    url = CHAT_API,
  ): Promise<unknown> {
    let response;
    try {
      response = await this.transport.send({
        url,
        method: 'POST',
        headers: body instanceof FormData
          ? { authorization: `Bearer ${this.apiKey}` }
          : this.headers(),
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
    if (status >= 500) return new ProviderUnavailableError(this.name, detail, body);
    return new ProviderProtocolError(this.name, `HTTP ${status}: ${detail}`, body);
  }

  private parseResult(body: unknown): GenerationResult {
    const completion = body as OpenAiCompletion;
    const choice = completion?.choices?.[0];
    if (!choice) {
      throw new ProviderProtocolError(this.name, 'no choices in response', body);
    }

    return {
      text: choice.message?.content ?? '',
      usage: mapUsage(completion.usage),
      model: completion.model ?? this.defaultModel,
      stopReason: mapStopReason(choice.finish_reason),
    };
  }
}

// ── wire shapes ────────────────────────────────────────────────────────────

interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}
interface OpenAiCompletion {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  usage?: OpenAiUsage;
  model?: string;
}
interface OpenAiEmbeddings {
  data?: { embedding?: number[]; index?: number }[];
  usage?: { prompt_tokens?: number };
}
interface OpenAiStreamChunk {
  choices?: { delta?: { content?: string }; finish_reason?: string }[];
  usage?: OpenAiUsage;
}

function mapUsage(usage?: OpenAiUsage): TokenUsage {
  const cached = usage?.prompt_tokens_details?.cached_tokens;
  return {
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
  };
}

function mapStopReason(reason?: string): StopReason {
  switch (reason) {
    case 'length':
      return 'max_tokens';
    case 'stop':
      return 'end';
    case 'content_filter':
      return 'refusal';
    default:
      return 'end';
  }
}

function toOpenAiMessage(message: Message): unknown {
  if (typeof message.content === 'string') return message;
  return {
    role: message.role,
    content: message.content.map((part) =>
      part.type === 'image'
        ? {
            type: 'image_url',
            image_url: { url: `data:${part.mediaType};base64,${part.data}` },
          }
        : { type: 'text', text: part.text },
    ),
  };
}

function errorMessage(body: unknown): string {
  const e = body as { error?: { message?: string } };
  if (typeof e?.error?.message === 'string') return e.error.message;
  return typeof body === 'string' ? body.slice(0, 200) : 'no detail';
}
