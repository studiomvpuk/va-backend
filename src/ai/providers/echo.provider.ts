import { ProviderContentError } from './errors';
import type { HttpTransport } from './transport';
import type {
  GenerationChunk,
  GenerationRequest,
  GenerationResult,
  IEmbedder,
  ITextGenerator,
  TokenUsage,
} from './ai-provider.interface';

/** Same width as the `vector(1536)` column, so rows are structurally valid. */
const ECHO_DIMENSIONS = 1536;

/**
 * A third provider, added to test the open/closed claim rather than assert it.
 *
 * If the seam works, this file plus one registry line is the entire change. It
 * also earns its place: it lets the app run end to end with no API key and no
 * network, which is worth having for local work on the screens.
 */
export class EchoProvider implements ITextGenerator, IEmbedder {
  readonly name = 'echo';

  /**
   * Tagged, and the tag is load-bearing. Vectors produced here measure WORD
   * OVERLAP, not meaning: "notice period" and "how long until you can start"
   * share no tokens and score zero, where a real embedder scores them close.
   * So the bank must never compare an echo vector with an OpenAI one. It
   * cannot, because QaBankService filters on embeddingModel — every entry
   * written under a different embedder is treated as having no vector at all
   * and falls back to exact matching.
   *
   * This exists so the gap → answer → bank loop can be exercised end to end
   * with no API key, not so semantic search can be evaluated without one.
   */
  readonly embeddingModel = 'echo-lexical-1';
  readonly dimensions = ECHO_DIMENSIONS;

  // Takes the standard provider shape and uses neither — it has nothing to
  // call and nothing to authenticate against.
  constructor(_transport: HttpTransport, _apiKey: string) {}

  async generate(request: GenerationRequest): Promise<GenerationResult> {
    const last = request.messages[request.messages.length - 1];
    const text = typeof last?.content === 'string' ? last.content : '';
    if (!text) throw new ProviderContentError(this.name, 'nothing to echo');

    return {
      text: `[echo] ${text.slice(0, 500)}`,
      usage: { inputTokens: text.length, outputTokens: text.length },
      model: 'echo-1',
      stopReason: 'end',
    };
  }

  async *stream(request: GenerationRequest): AsyncIterable<GenerationChunk> {
    const result = await this.generate(request);
    for (const word of result.text.split(' ')) {
      yield { delta: `${word} `, done: false };
    }
    yield { delta: '', done: true, usage: result.usage, stopReason: 'end' };
  }

  embed(input: { texts: string[] }): Promise<{ vectors: number[][]; usage: TokenUsage }> {
    const vectors = input.texts.map((text) => hashedBagOfWords(text));
    const inputTokens = input.texts.reduce((n, t) => n + t.length, 0);
    return Promise.resolve({ vectors, usage: { inputTokens, outputTokens: 0 } });
  }
}

/**
 * Hash each word into a bucket, then L2-normalise so cosine similarity means
 * what it means everywhere else. Two questions built from the same words land
 * close; two built from different words land orthogonal.
 */
function hashedBagOfWords(text: string): number[] {
  const vector = new Array<number>(ECHO_DIMENSIONS).fill(0);
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

  for (const word of words) {
    // FNV-1a, 32-bit. Chosen for being short and stable across runs, which is
    // all a fake needs — it is not a security hash and never used as one.
    let hash = 0x811c9dc5;
    for (let i = 0; i < word.length; i++) {
      hash ^= word.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    vector[hash % ECHO_DIMENSIONS] += 1;
  }

  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (magnitude === 0) return vector;
  return vector.map((v) => v / magnitude);
}
