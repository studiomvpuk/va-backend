/**
 * Three interfaces, not one.
 *
 * PRD §2.4 (Interface Segregation): Whisper transcribes and cannot draft;
 * a text model drafts and may not transcribe. A single fat `IAiProvider` would
 * force stub methods that throw — which is exactly the Liskov violation the
 * substitutability rule above it is trying to prevent.
 *
 * A provider implements whichever of these it can actually do, and the module
 * binds each capability token to whichever implementation offers it.
 */

export type Role = 'user' | 'assistant';

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ImagePart {
  type: 'image';
  /** base64, no data: prefix. */
  data: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
}

export type ContentPart = TextPart | ImagePart;

export interface Message {
  role: Role;
  content: string | ContentPart[];
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens served from the provider's prompt cache, when it reports them. */
  cachedInputTokens?: number;
}

export interface GenerationRequest {
  /** System preamble. The ATS style guide lives here, not in each call site. */
  system?: string;
  messages: Message[];
  maxTokens: number;
  temperature?: number;
  /**
   * A stable prefix the provider may cache across calls — in this product, the
   * Client's profile, which is identical for every application they make.
   * Providers that cannot cache ignore this and simply prepend it.
   */
  cacheablePrefix?: string;
  /** Overrides the provider's default model. */
  model?: string;
  signal?: AbortSignal;
}

export type StopReason = 'end' | 'max_tokens' | 'stop_sequence' | 'refusal';

export interface GenerationResult {
  text: string;
  usage: TokenUsage;
  model: string;
  stopReason: StopReason;
}

export interface GenerationChunk {
  /** Incremental text. Empty on a metadata-only chunk. */
  delta: string;
  done: boolean;
  /** Present on the final chunk. */
  usage?: TokenUsage;
  stopReason?: StopReason;
}

/** Drafting, scoring, classification — anything that turns prompt into text. */
export interface ITextGenerator {
  readonly name: string;
  generate(request: GenerationRequest): Promise<GenerationResult>;
  stream(request: GenerationRequest): AsyncIterable<GenerationChunk>;
}

/** Reading text out of a VA's screenshot of a job posting. */
export interface IVisionExtractor {
  readonly name: string;
  extractText(input: {
    image: ImagePart;
    /** What to pull out, when the caller wants something specific. */
    instruction?: string;
    signal?: AbortSignal;
  }): Promise<{ text: string; usage: TokenUsage }>;
}

/** Client voice-note answers to knowledge-gap questions (Phase 10). */
export interface ITranscriber {
  readonly name: string;
  transcribe(input: {
    audio: Buffer;
    mediaType: string;
    signal?: AbortSignal;
  }): Promise<{ text: string }>;
}

/**
 * Turning a question into a vector so the Q&A bank can match on meaning
 * rather than wording (PRD §5.7).
 *
 * Separate from ITextGenerator for the same reason ITranscriber is: Anthropic
 * has no embeddings endpoint, so a fat interface would force a method that
 * throws. Everything that consumes this is written to survive its absence —
 * an entry with no embedding is still matched exactly.
 *
 * `dimensions` is on the interface because the column is `vector(1536)`. A
 * provider whose vectors are a different width cannot be swapped in silently:
 * the caller compares this number to the stored width and refuses rather than
 * writing rows that will never match anything.
 */
export interface IEmbedder {
  readonly name: string;
  readonly embeddingModel: string;
  readonly dimensions: number;
  embed(input: {
    texts: string[];
    signal?: AbortSignal;
  }): Promise<{ vectors: number[][]; usage: TokenUsage }>;
}

/**
 * Looking something up on the open web (PRD Phase 8).
 *
 * A fifth capability rather than a method on ITextGenerator, for the reason all
 * of these are split: no text model here searches, and the one vendor that does
 * offer it bundles it with generation in a way that would make "which model
 * drafts" and "can we research" the same decision. They are not.
 *
 * Results carry their URL. That is not a nicety — the prep document's
 * background section is only allowed to say things that trace back to one of
 * these, so a result without a source is unusable rather than merely untidy.
 */
export interface SearchResult {
  title: string;
  url: string;
  /** The engine's extract. Short, and not to be treated as the full page. */
  snippet: string;
  /** When the engine reports one. Company facts go stale. */
  publishedAt?: string;
}

export interface ISearchProvider {
  readonly name: string;
  search(input: {
    query: string;
    /** Upper bound; a provider may return fewer, including none. */
    limit?: number;
    signal?: AbortSignal;
  }): Promise<SearchResult[]>;
}

export const TEXT_GENERATOR = Symbol('TEXT_GENERATOR');
export const SECONDARY_TEXT_GENERATOR = Symbol('SECONDARY_TEXT_GENERATOR');
export const VISION_EXTRACTOR = Symbol('VISION_EXTRACTOR');
export const TRANSCRIBER = Symbol('TRANSCRIBER');
export const EMBEDDER = Symbol('EMBEDDER');
export const SEARCH_PROVIDER = Symbol('SEARCH_PROVIDER');
