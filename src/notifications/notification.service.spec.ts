import { NotificationService } from './notification.service';
import { ChannelDispatcher } from './channel-dispatcher';
import type { INotificationRepository } from './notification.repository';
import type { NotificationRequest, NotificationView } from './notification.types';
import type { INotificationChannel } from './channels/notification-channel';
import type { PrismaService } from '../core/persistence/prisma.service';
import { tenantContext } from '../core/tenancy/tenant.context';

class FakeRepository implements INotificationRepository {
  readonly created: NotificationRequest[] = [];
  failCreate = false;

  create(request: NotificationRequest): Promise<NotificationView> {
    if (this.failCreate) return Promise.reject(new Error('database down'));
    this.created.push(request);
    return Promise.resolve({
      id: `n${this.created.length}`,
      kind: request.kind,
      title: request.title,
      body: request.body,
      linkPath: request.linkPath ?? null,
      readAt: null,
      createdAt: new Date(),
    });
  }

  list(): Promise<NotificationView[]> {
    return Promise.resolve([]);
  }
  countUnread(): Promise<number> {
    return Promise.resolve(0);
  }
  markRead(): Promise<NotificationView | null> {
    return Promise.resolve(null);
  }
  markAllRead(): Promise<number> {
    return Promise.resolve(0);
  }
}

function fakePrisma(email = 'client@example.com') {
  return {
    client: {
      client: { findUnique: () => Promise.resolve({ email }) },
    },
  } as unknown as PrismaService;
}

const request: NotificationRequest = {
  kind: 'KNOWLEDGE_GAP',
  title: 'A question needs your answer',
  body: 'Sky Capital asked about your notice period.',
  linkPath: '/dashboard#gap-1',
  urgent: true,
};

/** Every test runs inside a tenant, because notifying without one must throw. */
function withTenant<T>(fn: () => Promise<T>): Promise<T> {
  return tenantContext.run(
    { clientId: 'client-1', actorType: 'CLIENT', actorId: 'client-1' },
    fn,
  );
}

describe('NotificationService', () => {
  it('returns as soon as the record is written, without waiting for a channel', () => {
    const repository = new FakeRepository();
    let release!: () => void;
    const slow: INotificationChannel = {
      channel: 'slow',
      shouldSend: () => Promise.resolve(true),
      send: () => new Promise<void>((resolve) => (release = resolve)),
    };
    const dispatcher = new ChannelDispatcher([slow], () => Promise.resolve());
    const service = new NotificationService(repository, dispatcher, fakePrisma());

    return withTenant(async () => {
      // Resolves while the channel is still mid-send: a VA waiting on a reply
      // in chat must not be held up by an SMTP handshake.
      const notification = await service.notify(request);

      expect(notification.id).toBe('n1');
      expect(repository.created).toHaveLength(1);

      release();
      await dispatcher.drain();
    });
  });

  it('writes the durable record BEFORE dispatching, not after', async () => {
    const repository = new FakeRepository();
    let createdWhenDispatched = -1;
    const spy: INotificationChannel = {
      channel: 'spy',
      shouldSend: () => {
        createdWhenDispatched = repository.created.length;
        return Promise.resolve(false);
      },
      send: () => Promise.resolve(),
    };
    const dispatcher = new ChannelDispatcher([spy], () => Promise.resolve());
    const service = new NotificationService(repository, dispatcher, fakePrisma());

    await withTenant(async () => {
      await service.notify(request);
      await dispatcher.drain();
    });

    // If dispatch ran first, a channel could deliver a notification the Client
    // will never find in the app.
    expect(createdWhenDispatched).toBe(1);
  });

  it('fails the call when the durable record cannot be written', async () => {
    // A notification nobody can find later is worse than an error the caller
    // can react to — so this one does NOT degrade quietly.
    const repository = new FakeRepository();
    repository.failCreate = true;
    const service = new NotificationService(
      repository,
      new ChannelDispatcher([], () => Promise.resolve()),
      fakePrisma(),
    );

    await expect(withTenant(() => service.notify(request))).rejects.toThrow('database down');
  });

  it('still stores the notification when every channel fails', async () => {
    const repository = new FakeRepository();
    const dead: INotificationChannel = {
      channel: 'dead',
      shouldSend: () => Promise.resolve(true),
      send: () => Promise.reject(new Error('down')),
    };
    const dispatcher = new ChannelDispatcher([dead], () => Promise.resolve());
    const service = new NotificationService(repository, dispatcher, fakePrisma());

    const result = await withTenant(async () => {
      const notification = await service.notify(request);
      await dispatcher.drain();
      return notification;
    });

    expect(result.id).toBe('n1');
    expect(repository.created).toHaveLength(1);
  });

  it('refuses to notify with no tenant in context', async () => {
    // `Client` is the tenant, not a tenant-scoped model, so the Prisma
    // extension cannot catch this. Without the explicit check the email would
    // go to whichever Client the database returned first.
    const service = new NotificationService(
      new FakeRepository(),
      new ChannelDispatcher([], () => Promise.resolve()),
      fakePrisma(),
    );

    await expect(service.notify(request)).rejects.toThrow(/tenant/i);
  });

  it('reports per-channel outcomes when the caller waits', async () => {
    const good: INotificationChannel = {
      channel: 'good',
      shouldSend: () => Promise.resolve(true),
      send: () => Promise.resolve(),
    };
    const bad: INotificationChannel = {
      channel: 'bad',
      shouldSend: () => Promise.resolve(true),
      send: () => Promise.reject(new Error('nope')),
    };
    const service = new NotificationService(
      new FakeRepository(),
      new ChannelDispatcher([good, bad], () => Promise.resolve()),
      fakePrisma(),
    );

    const { outcomes } = await withTenant(() => service.notifyAndWait(request));

    expect(outcomes).toEqual([
      { channel: 'good', status: 'sent', attempts: 1 },
      expect.objectContaining({ channel: 'bad', status: 'failed' }),
    ]);
  });
});
