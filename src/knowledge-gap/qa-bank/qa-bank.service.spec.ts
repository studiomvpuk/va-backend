import { QaBankService } from './qa-bank.service';
import type { IQaBankRepository, QaBankRow, UpsertQaEntry } from './qa-bank.repository';
import type { IEmbedder } from '../../ai/providers/ai-provider.interface';
import type { ProviderFactory } from '../../ai/provider-factory';

const MODEL = 'test-embedder-1';
const DIMENSIONS = 3;

/** Deterministic vectors, hand-built so the expected similarity is obvious. */
const VECTORS: Record<string, number[]> = {
  'What is your notice period?': [1, 0, 0],
  'How much notice must you give?': [0.97, 0.24, 0],
  'What are your salary expectations?': [0, 1, 0],
};

class FakeEmbedder implements IEmbedder {
  readonly name = 'fake';
  readonly embeddingModel = MODEL;
  readonly dimensions = DIMENSIONS;
  calls = 0;

  constructor(private readonly failWith?: Error) {}

  embed(input: { texts: string[] }) {
    this.calls++;
    if (this.failWith) return Promise.reject(this.failWith);
    return Promise.resolve({
      vectors: input.texts.map((t) => VECTORS[t] ?? [0, 0, 1]),
      usage: { inputTokens: 1, outputTokens: 0 },
    });
  }
}

class FakeRepository implements IQaBankRepository {
  upserts: UpsertQaEntry[] = [];

  constructor(public rows: QaBankRow[] = []) {}

  list(): Promise<QaBankRow[]> {
    return Promise.resolve(this.rows);
  }

  upsert(entry: UpsertQaEntry): Promise<QaBankRow> {
    this.upserts.push(entry);
    const row: QaBankRow = {
      id: 'new',
      questionText: entry.questionText,
      answer: entry.answer,
      embedding: entry.embedding,
      embeddingModel: entry.embeddingModel,
      confirmedAt: new Date(),
    };
    return Promise.resolve(row);
  }

  countForClient(): Promise<number> {
    return Promise.resolve(this.rows.length);
  }
}

function row(overrides: Partial<QaBankRow> & { questionText: string }): QaBankRow {
  return {
    id: overrides.id ?? 'entry-1',
    answer: overrides.answer ?? 'One month.',
    embedding: overrides.embedding ?? VECTORS[overrides.questionText] ?? [],
    embeddingModel:
      overrides.embeddingModel === undefined ? MODEL : overrides.embeddingModel,
    confirmedAt: overrides.confirmedAt ?? new Date('2026-01-01'),
    questionText: overrides.questionText,
  };
}

function build(repo: IQaBankRepository, embedder: IEmbedder | null) {
  const factory = {
    embedder: () =>
      embedder ? Promise.resolve(embedder) : Promise.reject(new Error('no key')),
  } as unknown as ProviderFactory;
  return new QaBankService(repo, factory);
}

describe('QaBankService', () => {
  describe('lookup', () => {
    it('matches a paraphrase through the embedder', async () => {
      const repo = new FakeRepository([row({ questionText: 'What is your notice period?' })]);
      const service = build(repo, new FakeEmbedder());

      const match = await service.lookup('How much notice must you give?');

      expect(match?.strategy).toBe('semantic');
      expect(match?.entry.answer).toBe('One month.');
    });

    it('does not match a different question that happens to be in the bank', async () => {
      const repo = new FakeRepository([row({ questionText: 'What is your notice period?' })]);
      const service = build(repo, new FakeEmbedder());

      expect(await service.lookup('What are your salary expectations?')).toBeNull();
    });

    it('still matches exactly when no embedder is configured', async () => {
      const repo = new FakeRepository([row({ questionText: 'What is your notice period?' })]);
      const service = build(repo, null);

      const match = await service.lookup('what is your notice period');

      expect(match?.strategy).toBe('exact');
    });

    it('falls back to exact matching when the embedder throws', async () => {
      const repo = new FakeRepository([row({ questionText: 'What is your notice period?' })]);
      const service = build(repo, new FakeEmbedder(new Error('rate limited')));

      // The paraphrase is lost, but nothing throws and the exact case survives.
      await expect(service.lookup('How much notice must you give?')).resolves.toBeNull();
      await expect(service.lookup('What is your notice period?')).resolves.toMatchObject({
        strategy: 'exact',
      });
    });

    it('ignores vectors written by a different embedder', async () => {
      // Same width, different model: the numbers are meaningless to this
      // embedder and must never be compared.
      const repo = new FakeRepository([
        row({
          questionText: 'What is your notice period?',
          embeddingModel: 'some-other-model-1',
        }),
      ]);
      const service = build(repo, new FakeEmbedder());

      expect(await service.lookup('How much notice must you give?')).toBeNull();
      // ...but the entry is not lost — it still answers its own question.
      expect(await service.lookup('What is your notice period?')).toMatchObject({
        strategy: 'exact',
      });
    });

    it('ignores a stored vector of the wrong width', async () => {
      const repo = new FakeRepository([
        row({ questionText: 'What is your notice period?', embedding: [1, 0] }),
      ]);
      const service = build(repo, new FakeEmbedder());

      expect(await service.lookup('How much notice must you give?')).toBeNull();
    });

    it('skips the embedding call entirely when the bank is empty', async () => {
      const embedder = new FakeEmbedder();
      const service = build(new FakeRepository([]), embedder);

      expect(await service.lookup('anything at all')).toBeNull();
      expect(embedder.calls).toBe(0);
    });
  });

  describe('record', () => {
    it('stores the answer with its vector and the model that produced it', async () => {
      const repo = new FakeRepository();
      const service = build(repo, new FakeEmbedder());

      await service.record({
        questionText: 'What is your notice period?',
        answer: 'One month.',
        sourceGapId: 'gap-1',
      });

      expect(repo.upserts[0]).toMatchObject({
        questionText: 'What is your notice period?',
        answer: 'One month.',
        embedding: [1, 0, 0],
        embeddingModel: MODEL,
        sourceGapId: 'gap-1',
      });
    });

    it('stores the answer with no vector when embedding fails', async () => {
      const repo = new FakeRepository();
      const service = build(repo, new FakeEmbedder(new Error('down')));

      await service.record({
        questionText: 'What is your notice period?',
        answer: 'One month.',
      });

      // The answer is never lost because the embedder was unavailable, and the
      // null model is what a later backfill looks for.
      expect(repo.upserts[0]).toMatchObject({ embedding: [], embeddingModel: null });
    });
  });
});
