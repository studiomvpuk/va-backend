import { PrepService } from './prep.service';
import { tenantContext } from '../core/tenancy/tenant.context';
import type { IJobQueue, JobName, JobPayloadMap } from '../core/jobs/job-queue';
import type { IPrepRepository, PrepDocumentView, PrepQuestion } from './prep.repository';
import type { TalkingPoint } from './prep-validation';

class FakeRepository implements IPrepRepository {
  claims = 0;
  private document: PrepDocumentView | null = null;

  claim(applicationId: string) {
    this.claims++;
    if (this.document) return Promise.resolve({ document: this.document, created: false });
    this.document = view(applicationId);
    return Promise.resolve({ document: this.document, created: true });
  }

  find(): Promise<PrepDocumentView | null> {
    return Promise.resolve(this.document);
  }
  complete(
    applicationId: string,
    _result: {
      companyBackground: string | null;
      likelyQuestions: PrepQuestion[];
      talkingPoints: TalkingPoint[];
      sources: string[];
    },
  ): Promise<PrepDocumentView> {
    return Promise.resolve(view(applicationId));
  }
  fail(): Promise<void> {
    return Promise.resolve();
  }
  evidenceFor() {
    return Promise.resolve({ profileFieldKeys: [], hasNarrative: false });
  }
}

function view(applicationId: string): PrepDocumentView {
  return {
    id: 'prep-1',
    applicationId,
    status: 'PENDING',
    failureReason: null,
    companyBackground: null,
    likelyQuestions: [],
    talkingPoints: [],
    sources: [],
    generatedAt: null,
    createdAt: new Date(),
    companyName: 'Sky Capital',
    roleTitle: 'Operations Lead',
  };
}

class RecordingQueue implements IJobQueue {
  readonly enqueued: { name: JobName; payload: unknown }[] = [];
  enqueue<N extends JobName>(name: N, payload: JobPayloadMap[N]): Promise<void> {
    this.enqueued.push({ name, payload });
    return Promise.resolve();
  }
}

function withTenant<T>(fn: () => Promise<T>): Promise<T> {
  return tenantContext.run(
    { clientId: 'client-1', actorType: 'CLIENT', actorId: 'client-1' },
    fn,
  );
}

describe('PrepService.request', () => {
  it('enqueues and returns a pending document', async () => {
    const repository = new FakeRepository();
    const queue = new RecordingQueue();
    const service = new PrepService(repository, queue);

    const document = await withTenant(() => service.request('app-1'));

    expect(document.status).toBe('PENDING');
    expect(queue.enqueued).toEqual([
      { name: 'prep-document.generate', payload: { clientId: 'client-1', applicationId: 'app-1' } },
    ]);
  });

  it('carries the tenant in the payload — a worker has no context to inherit', async () => {
    const queue = new RecordingQueue();
    await withTenant(() => new PrepService(new FakeRepository(), queue).request('app-1'));

    expect(queue.enqueued[0].payload).toMatchObject({ clientId: 'client-1' });
  });

  it('is idempotent: a second call enqueues nothing', async () => {
    // Two INTERVIEW clicks, a retry, two tabs. Without this the Client watches
    // a finished document revert to pending while a duplicate job re-runs.
    const repository = new FakeRepository();
    const queue = new RecordingQueue();
    const service = new PrepService(repository, queue);

    await withTenant(async () => {
      await service.request('app-1');
      await service.request('app-1');
      await service.request('app-1');
    });

    expect(queue.enqueued).toHaveLength(1);
    expect(repository.claims).toBe(3);
  });

  it('refuses without a tenant rather than queueing an unscoped job', async () => {
    const service = new PrepService(new FakeRepository(), new RecordingQueue());
    await expect(service.request('app-1')).rejects.toThrow(/tenant/i);
  });

  it('holds a queue, not a composer', () => {
    // The immediacy guarantee is structural: there is nothing on this class
    // that could do the research, so no future edit here can accidentally
    // await it on the request path.
    const service = new PrepService(new FakeRepository(), new RecordingQueue());
    const injected = Object.values(service as unknown as Record<string, unknown>);

    expect(injected.some((dep) => dep instanceof RecordingQueue)).toBe(true);
    expect(
      injected.some((dep) => typeof (dep as { compose?: unknown })?.compose === 'function'),
    ).toBe(false);
  });
});
