import { KnowledgeGapService } from './knowledge-gap.service';
import type {
  CreateGapInput,
  IKnowledgeGapRepository,
  KnowledgeGapView,
} from './knowledge-gap.repository';
import type { ISettingsRepository, ClientSettingsView } from '../settings/settings.repository';
import type { QaBankService } from './qa-bank/qa-bank.service';
import type { GapDetector } from './gap-detector';
import type { ProviderFactory } from '../ai/provider-factory';
import type { NotificationService } from '../notifications/notification.service';
import type { PrismaService } from '../core/persistence/prisma.service';
import type { NotificationRequest } from '../notifications/notification.types';
import type { GapMode, GapSignal } from './gap-resolution';

const QUESTION = 'What is your notice period?';

class FakeGapRepository implements IKnowledgeGapRepository {
  readonly created: CreateGapInput[] = [];
  rows: KnowledgeGapView[] = [];
  remainingAfterResolve = 0;

  create(input: CreateGapInput): Promise<KnowledgeGapView> {
    this.created.push(input);
    const view = gapView({
      id: `gap-${this.created.length}`,
      applicationId: input.applicationId,
      questionText: input.questionText,
      bestEffortAnswer: input.bestEffortAnswer,
    });
    this.rows.push(view);
    return Promise.resolve(view);
  }

  findById(id: string): Promise<KnowledgeGapView | null> {
    return Promise.resolve(this.rows.find((r) => r.id === id) ?? null);
  }

  list(): Promise<KnowledgeGapView[]> {
    return Promise.resolve(this.rows);
  }
  countUnresolved(): Promise<number> {
    return Promise.resolve(this.rows.filter((r) => !r.resolvedAt).length);
  }
  countUnresolvedForApplication(): Promise<number> {
    return Promise.resolve(this.remainingAfterResolve);
  }

  resolve(id: string, clientAnswer: string) {
    const found = this.rows.find((r) => r.id === id);
    if (!found) throw new Error('not found');
    const gap = { ...found, clientAnswer, resolvedAt: new Date() };
    this.rows = this.rows.map((r) => (r.id === id ? gap : r));
    return Promise.resolve({ gap, remainingForApplication: this.remainingAfterResolve });
  }
}

function gapView(overrides: Partial<KnowledgeGapView> = {}): KnowledgeGapView {
  return {
    id: 'gap-1',
    applicationId: 'app-1',
    vaId: 'va-1',
    questionText: QUESTION,
    bestEffortAnswer: null,
    clientAnswer: null,
    resolvedAt: null,
    createdAt: new Date('2026-03-01'),
    companyName: 'Sky Capital',
    roleTitle: 'Operations Lead',
    applicationStatus: 'BLOCKED',
    ...overrides,
  };
}

function build(options: {
  mode?: GapMode;
  signal?: GapSignal;
  bankHit?: string;
  remaining?: number;
  gapStatus?: string;
}) {
  const gaps = new FakeGapRepository();
  gaps.remainingAfterResolve = options.remaining ?? 0;

  const settings: ISettingsRepository = {
    get: () =>
      Promise.resolve({
        gapMode: options.mode ?? 'GUESS_AND_PROCEED',
        minFitScore: 6,
        byokEnabled: false,
        whatsappEnabled: false,
      } as ClientSettingsView),
    update: () => Promise.reject(new Error('not used')),
  };

  const banked: { questionText: string; answer: string }[] = [];
  const qaBank = {
    lookup: () =>
      Promise.resolve(
        options.bankHit
          ? { entry: { id: 'e1', questionText: QUESTION, answer: options.bankHit, embedding: null }, strategy: 'exact' as const, similarity: 1 }
          : null,
      ),
    record: (input: { questionText: string; answer: string }) => {
      banked.push(input);
      return Promise.resolve();
    },
  } as unknown as QaBankService;

  const detector = {
    detect: () =>
      Promise.resolve(
        options.signal ?? {
          bestEffortAnswer: 'One month',
          confidence: 'low' as const,
          assumption: 'standard UK notice',
        },
      ),
  } as unknown as GapDetector;

  const notified: NotificationRequest[] = [];
  const notifications = {
    notify: (request: NotificationRequest) => {
      notified.push(request);
      return Promise.resolve({ id: 'n1' });
    },
  } as unknown as NotificationService;

  const statusWrites: { id: string; status: string }[] = [];
  const prisma = {
    client: {
      application: {
        updateMany: (args: { where: { id: string }; data: { status: string } }) => {
          statusWrites.push({ id: args.where.id, status: args.data.status });
          return Promise.resolve({ count: 1 });
        },
      },
    },
  } as unknown as PrismaService;

  const transcripts: string[] = [];
  const providers = {
    transcriber: () =>
      Promise.resolve({
        name: 'fake',
        transcribe: () => Promise.resolve({ text: transcripts.shift() ?? '' }),
      }),
  } as unknown as ProviderFactory;

  const service = new KnowledgeGapService(
    gaps,
    settings,
    qaBank,
    detector,
    notifications,
    prisma,
    providers,
  );

  return { service, gaps, notified, statusWrites, banked, transcripts };
}

const question = {
  applicationId: 'app-1',
  vaId: 'va-1',
  questionText: QUESTION,
  profileContext: 'profile',
  companyName: 'Sky Capital',
  roleTitle: 'Operations Lead',
};

describe('KnowledgeGapService.answerQuestion', () => {
  it('answers from the Q&A bank without calling a model or recording a gap', async () => {
    const { service, gaps, notified } = build({ bankHit: 'One month.' });

    const outcome = await service.answerQuestion(question);

    expect(outcome).toEqual({ status: 'answered', answer: 'One month.', source: 'qa_bank' });
    expect(gaps.created).toHaveLength(0);
    expect(notified).toHaveLength(0);
  });

  it('answers from the profile without troubling the Client', async () => {
    // medium confidence, no assumption: the model is hedging about wording, not
    // missing a fact. A queue full of these is a queue nobody reads.
    const { service, gaps, notified } = build({
      signal: { bestEffortAnswer: 'One month', confidence: 'medium', assumption: '' },
    });

    const outcome = await service.answerQuestion(question);

    expect(outcome).toMatchObject({ status: 'answered', source: 'profile' });
    expect(gaps.created).toHaveLength(0);
    expect(notified).toHaveLength(0);
  });

  describe('GUESS_AND_PROCEED', () => {
    it('gives the VA the answer and tells the Client without urgency', async () => {
      const { service, gaps, notified, statusWrites } = build({ mode: 'GUESS_AND_PROCEED' });

      const outcome = await service.answerQuestion(question);

      expect(outcome).toMatchObject({
        status: 'answered_with_assumption',
        answer: 'One month',
        assumption: 'standard UK notice',
      });
      expect(gaps.created[0].bestEffortAnswer).toBe('One month');
      expect(notified[0]).toMatchObject({ kind: 'KNOWLEDGE_GAP', urgent: false });
      // Nothing was blocked: the application carries on.
      expect(statusWrites).toHaveLength(0);
    });
  });

  describe('ASK_FIRST', () => {
    it('pauses the application and notifies urgently', async () => {
      const { service, notified, statusWrites } = build({ mode: 'ASK_FIRST' });

      const outcome = await service.answerQuestion(question);

      expect(outcome.status).toBe('paused');
      expect(statusWrites).toEqual([{ id: 'app-1', status: 'BLOCKED' }]);
      expect(notified[0]).toMatchObject({ urgent: true });
    });

    it('never lets the best-effort answer reach the VA or the database', async () => {
      // The Client asked not to have anything guessed. A guess sitting in the
      // VA's chat window is a guess the VA will reasonably paste in.
      const { service, gaps } = build({ mode: 'ASK_FIRST' });

      const outcome = await service.answerQuestion(question);

      expect(JSON.stringify(outcome)).not.toContain('One month');
      expect(gaps.created[0].bestEffortAnswer).toBeNull();
    });

    it('puts the question, but not a guess, in the notification', async () => {
      const { service, notified } = build({ mode: 'ASK_FIRST' });
      await service.answerQuestion(question);

      expect(notified[0].body).toContain(QUESTION);
      expect(notified[0].body).not.toContain('One month');
    });
  });

  it('reads the mode at the moment of the gap, so a flip applies to the next question', async () => {
    let mode: GapMode = 'GUESS_AND_PROCEED';
    const { service, statusWrites } = build({ mode: 'ASK_FIRST' });
    // Rebuild with a settings repository that changes between calls.
    const settings: ISettingsRepository = {
      get: () =>
        Promise.resolve({
          gapMode: mode,
          minFitScore: 6,
          byokEnabled: false,
          whatsappEnabled: false,
        } as ClientSettingsView),
      update: () => Promise.reject(new Error('not used')),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).settings = settings;

    const first = await service.answerQuestion(question);
    expect(first.status).toBe('answered_with_assumption');

    mode = 'ASK_FIRST';
    const second = await service.answerQuestion(question);
    expect(second.status).toBe('paused');

    // Only the second one blocked anything — the flip was not retroactive.
    expect(statusWrites).toEqual([{ id: 'app-1', status: 'BLOCKED' }]);
  });
});

describe('KnowledgeGapService.answerGap', () => {
  it('banks the answer and resumes the application', async () => {
    const { service, statusWrites, banked } = build({ mode: 'ASK_FIRST', remaining: 0 });
    await service.answerQuestion(question);

    const resolved = await service.answerGap('gap-1', 'Three months, not one.');

    expect(resolved.clientAnswer).toBe('Three months, not one.');
    expect(banked).toEqual([{ questionText: QUESTION, answer: 'Three months, not one.', sourceGapId: 'gap-1' }]);
    expect(statusWrites).toEqual([
      { id: 'app-1', status: 'BLOCKED' },
      { id: 'app-1', status: 'IN_PROGRESS' },
    ]);
    expect(resolved.applicationStatus).toBe('IN_PROGRESS');
  });

  it('leaves the application blocked while another question is still waiting', async () => {
    const { service, statusWrites } = build({ mode: 'ASK_FIRST', remaining: 1 });
    await service.answerQuestion(question);

    await service.answerGap('gap-1', 'Three months.');

    expect(statusWrites).toEqual([{ id: 'app-1', status: 'BLOCKED' }]);
  });

  it('still resolves and resumes when the Q&A bank write fails', async () => {
    // An embedding outage must not roll back an answer the Client has given.
    const { service, statusWrites } = build({ mode: 'ASK_FIRST', remaining: 0 });
    await service.answerQuestion(question);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).qaBank = { record: () => Promise.reject(new Error('embedder down')) };

    const resolved = await service.answerGap('gap-1', 'Three months.');

    expect(resolved.clientAnswer).toBe('Three months.');
    expect(statusWrites).toContainEqual({ id: 'app-1', status: 'IN_PROGRESS' });
  });

  it('404s on an id that is not this Client’s', async () => {
    const { service } = build({});
    await expect(service.answerGap('someone-elses-gap', 'x')).rejects.toThrow(/not found/i);
  });
});

describe('KnowledgeGapService.answerGapByVoice', () => {
  const audio = { audio: Buffer.alloc(2_000), mediaType: 'audio/mp4' as const };

  it('transcribes, then goes through the same path as a typed answer', async () => {
    const { service, statusWrites, banked, transcripts } = build({
      mode: 'ASK_FIRST',
      remaining: 0,
    });
    await service.answerQuestion(question);
    transcripts.push('Three months, not one.');

    const { gap, transcript } = await service.answerGapByVoice('gap-1', audio);

    expect(transcript).toBe('Three months, not one.');
    expect(gap.clientAnswer).toBe('Three months, not one.');
    // Banked and resumed — one path, not a second implementation.
    expect(banked[0]).toMatchObject({ answer: 'Three months, not one.' });
    expect(statusWrites).toContainEqual({ id: 'app-1', status: 'IN_PROGRESS' });
  });

  it('refuses a transcriber’s guess at silence', async () => {
    // "you" is what Whisper returns for a pocket recording. Saving it would put
    // it in the Q&A bank and reuse it on every future application.
    const { service, transcripts, banked } = build({ mode: 'ASK_FIRST' });
    await service.answerQuestion(question);
    transcripts.push('you');

    await expect(service.answerGapByVoice('gap-1', audio)).rejects.toThrow(/Nothing could be made out/);
    expect(banked).toEqual([]);
  });

  it('refuses an oversized recording before spending a transcription call', async () => {
    const { service } = build({ mode: 'ASK_FIRST' });
    await expect(
      service.answerGapByVoice('gap-1', {
        audio: Buffer.alloc(9 * 1024 * 1024),
        mediaType: 'audio/mp4',
      }),
    ).rejects.toThrow(/too long/);
  });
});
