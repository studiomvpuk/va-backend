import { EchoProvider } from './echo.provider';
import {
  describeTextGeneratorCoreContract,
  ScriptedTransport,
} from './provider-contract';
import { ProviderContentError } from './errors';

/**
 * The third provider, held to the half of the contract that applies to it.
 *
 * It makes no HTTP call, so the transport error-normalisation half would be
 * testing nothing. The core half — result shape, usage, stream termination — is
 * what every caller actually depends on, and it passes that.
 */
describeTextGeneratorCoreContract(
  'EchoProvider',
  () => new EchoProvider(new ScriptedTransport(), ''),
);

describe('EchoProvider', () => {
  const provider = () => new EchoProvider(new ScriptedTransport(), '');

  it('echoes the last message so a screen has something to render', async () => {
    const result = await provider().generate({
      maxTokens: 100,
      messages: [{ role: 'user', content: 'What is your notice period?' }],
    });
    expect(result.text).toContain('What is your notice period?');
  });

  it('throws a normalised ProviderError when there is nothing to echo', async () => {
    await expect(
      provider().generate({ maxTokens: 10, messages: [] }),
    ).rejects.toBeInstanceOf(ProviderContentError);
  });

  describe('embeddings', () => {
    const embedder = new EchoProvider(null as never, '');

    it('produces vectors of the width the column expects', async () => {
      const { vectors } = await embedder.embed({ texts: ['notice period'] });
      expect(vectors[0]).toHaveLength(1536);
      expect(embedder.dimensions).toBe(1536);
    });

    it('is unit length, so cosine similarity means what it means elsewhere', async () => {
      const { vectors } = await embedder.embed({ texts: ['how much notice'] });
      const magnitude = Math.sqrt(vectors[0].reduce((s, v) => s + v * v, 0));
      expect(magnitude).toBeCloseTo(1, 10);
    });

    it('is deterministic across calls', async () => {
      const a = await embedder.embed({ texts: ['same question'] });
      const b = await embedder.embed({ texts: ['same question'] });
      expect(a.vectors[0]).toEqual(b.vectors[0]);
    });

    it('scores word overlap, NOT meaning — which is why it is tagged', async () => {
      const { vectors } = await embedder.embed({
        texts: [
          'what is your notice period',
          'what is your notice period really',
          'how long until you can start',
        ],
      });
      const cosine = (a: number[], b: number[]) =>
        a.reduce((sum, v, i) => sum + v * b[i], 0);

      // Shares every word but one: close.
      expect(cosine(vectors[0], vectors[1])).toBeGreaterThan(0.8);
      // Same question in plain English, no shared words: orthogonal. A real
      // embedder scores these together, and that gap is the reason
      // embeddingModel exists.
      expect(cosine(vectors[0], vectors[2])).toBe(0);
      expect(embedder.embeddingModel).toBe('echo-lexical-1');
    });

    it('returns a zero vector rather than throwing on empty text', async () => {
      const { vectors } = await embedder.embed({ texts: ['!!!'] });
      expect(vectors[0].every((v) => v === 0)).toBe(true);
    });
  });
});
