import { PrepGenerationHandler } from './prep-generation.handler';
import { JobRegistry } from '../core/jobs/job-registry';
import { currentTenant } from '../core/tenancy/tenant.context';
import type { PrepComposer } from './prep-composer';
import type { NotificationService } from '../notifications/notification.service';
import type { NotificationRequest } from '../notifications/notification.types';
import type { IPrepRepository, PrepDocumentView } from './prep.repository';
import type { ValidatedPrep } from './prep-validation';
import type { IApplicationRepository } from '../applications/application.repository';
import type { ProfileService } from '../profile/profile.service';

const GOOD_PREP: ValidatedPrep = {
  background: 'A Manchester investment firm.',
  sources: ['https://example.com/sky'],
  questions: [{ question: 'Why this role?', why: 'motivation' }],
  talkingPoints: [{ point: 'Four years on payments.', basis: { kind: 'narrative' } }],
  discarded: [],
};

const EMPTY_PREP: ValidatedPrep = {
  background: null,
  sources: [],
  questions: [],
  talkingPoints: [],
  discarded: ['everything'],
};

function build(options: { prep?: ValidatedPrep; composeThrows?: Error; missing?: boolean } = {}) {
  const completed: unknown[] = [];
  const failed: { applicationId: string; reason: string }[] = [];
  const notified: NotificationRequest[] = [];
  /** The tenant as seen from inside each repository call. */
  const tenantsSeen: (string | null | undefined)[] = [];

  const repository = {
    find: () => Promise.resolve(null),
    claim: () => Promise.reject(new Error('not used')),
    complete: (applicationId: string, result: unknown) => {
      tenantsSeen.push(currentTenant()?.clientId);
      completed.push(result);
      return Promise.resolve({ applicationId } as PrepDocumentView);
    },
    fail: (applicationId: string, reason: string) => {
      failed.push({ applicationId, reason });
      return Promise.resolve();
    },
    evidenceFor: () => {
      tenantsSeen.push(currentTenant()?.clientId);
      return Promise.resolve({ profileFieldKeys: ['location'], hasNarrative: true });
    },
  } as unknown as IPrepRepository;

  const applications = {
    find: (id: string) => {
      tenantsSeen.push(currentTenant()?.clientId);
      return Promise.resolve(
        options.missing
          ? null
          : { id, companyName: 'Sky Capital', roleTitle: 'Operations Lead' },
      );
    },
    jobDescription: () => Promise.resolve('A posting.'),
  } as unknown as IApplicationRepository;

  const composer = {
    compose: () =>
      options.composeThrows
        ? Promise.reject(options.composeThrows)
        : Promise.resolve(options.prep ?? GOOD_PREP),
  } as unknown as PrepComposer;

  const notifications = {
    notify: (request: NotificationRequest) => {
      notified.push(request);
      return Promise.resolve({ id: 'n1' });
    },
  } as unknown as NotificationService;

  const profile = {
    getProfile: () =>
      Promise.resolve({
        narrative: 'Four years building payment systems.',
        fields: [
          { key: 'location', label: 'Location', visibility: 'GENERAL', value: 'Manchester' },
          { key: 'ni_number', label: 'NI number', visibility: 'SENSITIVE', value: null },
        ],
      }),
  } as unknown as ProfileService;

  const handler = new PrepGenerationHandler(
    new JobRegistry(),
    composer,
    notifications,
    repository,
    applications,
    profile,
  );

  return { handler, completed, failed, notified, tenantsSeen };
}

const payload = { clientId: 'client-1', applicationId: 'app-1' };

describe('PrepGenerationHandler', () => {
  it('registers itself with the job registry', () => {
    const registry = new JobRegistry();
    const handler = new PrepGenerationHandler(
      registry,
      {} as PrepComposer,
      {} as NotificationService,
      {} as IPrepRepository,
      {} as IApplicationRepository,
      {} as ProfileService,
    );

    handler.onModuleInit();
    expect([...registry.asMap().keys()]).toEqual(['prep-document.generate']);
  });

  it('opens a tenant context from the payload', async () => {
    // A job runs long after the request that queued it, possibly on another
    // machine. There is no AsyncLocalStorage store to inherit — without this
    // every query underneath throws MissingTenantContextError.
    const { handler, tenantsSeen } = build();

    expect(currentTenant()).toBeUndefined();
    await handler.handle(payload);

    expect(tenantsSeen.length).toBeGreaterThan(0);
    expect(new Set(tenantsSeen)).toEqual(new Set(['client-1']));
    // And it closes again afterwards.
    expect(currentTenant()).toBeUndefined();
  });

  it('stores the document and notifies, without urgency', async () => {
    const { handler, completed, notified } = build();
    await handler.handle(payload);

    expect(completed[0]).toMatchObject({
      companyBackground: 'A Manchester investment firm.',
      sources: ['https://example.com/sky'],
    });
    // An interview is scheduled. Nothing is blocked on reading this in the
    // next five minutes, and an email for it would be noise.
    expect(notified[0]).toMatchObject({ kind: 'SYSTEM', urgent: false });
    expect(notified[0].linkPath).toBe('/applications/app-1/prep');
  });

  it('fails the document rather than storing an empty one', async () => {
    const { handler, completed, failed, notified } = build({ prep: EMPTY_PREP });
    await handler.handle(payload);

    expect(completed).toEqual([]);
    expect(failed[0].reason).toContain('Nothing could be verified');
    // Still notified: a Client waiting on notes needs to know they are not coming.
    expect(notified).toHaveLength(1);
  });

  it('records the failure on the row AND rethrows so the queue retries', async () => {
    const { handler, failed } = build({ composeThrows: new Error('provider exploded') });

    await expect(handler.handle(payload)).rejects.toThrow('provider exploded');
    // The row stops the Client's spinner; the rethrow gives Redis its retry.
    expect(failed[0].reason).toContain('provider exploded');
  });

  it('does nothing when the application was deleted between queue and run', async () => {
    const { handler, failed, notified, completed } = build({ missing: true });

    await expect(handler.handle(payload)).resolves.toBeUndefined();
    expect([completed, failed, notified].every((l) => l.length === 0)).toBe(true);
  });

  it('never puts a sensitive field in the profile context', async () => {
    // Even the LABEL of a sensitive field is a list of what this Client
    // considers private, and a prep document has no use for it.
    const composed: { profileContext: string }[] = [];
    const { handler } = build();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (handler as any).composer = {
      compose: (input: { profileContext: string }) => {
        composed.push(input);
        return Promise.resolve(GOOD_PREP);
      },
    };

    await handler.handle(payload);

    expect(composed[0].profileContext).toContain('Manchester');
    expect(composed[0].profileContext).not.toContain('NI number');
    expect(composed[0].profileContext).not.toContain('ni_number');
  });
});
