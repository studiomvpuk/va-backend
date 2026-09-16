import { ChannelDispatcher, RETRY_DELAYS_MS } from './channel-dispatcher';
import {
  PermanentDeliveryError,
  type ChannelPayload,
  type INotificationChannel,
} from './channels/notification-channel';
import type { NotificationView } from './notification.types';

const notification: NotificationView = {
  id: 'n1',
  kind: 'KNOWLEDGE_GAP',
  title: 'A question needs your answer',
  body: 'Sky Capital asked about your notice period.',
  linkPath: '/dashboard#gap-1',
  readAt: null,
  createdAt: new Date('2026-03-01T09:00:00Z'),
};

const payload: ChannelPayload = {
  notification,
  urgent: true,
  clientEmail: 'client@example.com',
};

class FakeChannel implements INotificationChannel {
  sends = 0;
  constructor(
    readonly channel: string,
    private readonly behaviour: {
      shouldSend?: boolean | Error;
      failTimes?: number;
      failWith?: Error;
    } = {},
  ) {}

  shouldSend(): Promise<boolean> {
    const s = this.behaviour.shouldSend;
    if (s instanceof Error) return Promise.reject(s);
    return Promise.resolve(s ?? true);
  }

  send(): Promise<void> {
    this.sends++;
    if (this.sends <= (this.behaviour.failTimes ?? 0)) {
      return Promise.reject(this.behaviour.failWith ?? new Error('transient'));
    }
    return Promise.resolve();
  }
}

/** No real waiting; the delays themselves are recorded so they can be asserted. */
function build(channels: INotificationChannel[]) {
  const waited: number[] = [];
  const dispatcher = new ChannelDispatcher(channels, (ms) => {
    waited.push(ms);
    return Promise.resolve();
  });
  return { dispatcher, waited };
}

describe('ChannelDispatcher', () => {
  describe('independence — the property this class exists for', () => {
    it('delivers to every other channel when one throws', async () => {
      const broken = new FakeChannel('broken', {
        failTimes: 99,
        failWith: new Error('smtp down'),
      });
      const working = new FakeChannel('working');
      const alsoWorking = new FakeChannel('also-working');

      const { dispatcher } = build([broken, working, alsoWorking]);
      const outcomes = await dispatcher.deliver(payload);

      expect(working.sends).toBe(1);
      expect(alsoWorking.sends).toBe(1);
      expect(outcomes.find((o) => o.channel === 'broken')?.status).toBe('failed');
      expect(outcomes.filter((o) => o.status === 'sent')).toHaveLength(2);
    });

    it('delivers to later channels even when the FIRST one throws', async () => {
      // Ordering matters: a sequential loop with an await inside would stop
      // here, and that is the obvious way to write this class.
      const broken = new FakeChannel('broken', { failTimes: 99 });
      const working = new FakeChannel('working');

      const { dispatcher } = build([broken, working]);
      await dispatcher.deliver(payload);

      expect(working.sends).toBe(1);
    });

    it('never rejects, whatever the channels do', async () => {
      const exploding: INotificationChannel = {
        channel: 'exploding',
        shouldSend: () => {
          throw new Error('thrown synchronously, not rejected');
        },
        send: () => Promise.resolve(),
      };

      const { dispatcher } = build([exploding, new FakeChannel('fine')]);
      await expect(dispatcher.deliver(payload)).resolves.toHaveLength(2);
    });
  });

  describe('retry', () => {
    it('retries a transient failure and reports the attempt it succeeded on', async () => {
      const flaky = new FakeChannel('flaky', { failTimes: 1 });
      const { dispatcher, waited } = build([flaky]);

      const [outcome] = await dispatcher.deliver(payload);

      expect(outcome).toMatchObject({ status: 'sent', attempts: 2 });
      expect(waited).toEqual([RETRY_DELAYS_MS[0]]);
    });

    it('backs off between attempts and gives up after the last delay', async () => {
      const dead = new FakeChannel('dead', { failTimes: 99 });
      const { dispatcher, waited } = build([dead]);

      const [outcome] = await dispatcher.deliver(payload);

      expect(dead.sends).toBe(RETRY_DELAYS_MS.length + 1);
      expect(waited).toEqual([...RETRY_DELAYS_MS]);
      expect(outcome.status).toBe('failed');
    });

    it('does not retry a permanent failure', async () => {
      // A bad address is still bad on the third attempt; retrying costs time
      // and, on a metered provider, money.
      const bad = new FakeChannel('bad', {
        failTimes: 99,
        failWith: new PermanentDeliveryError('email', 'no usable address'),
      });
      const { dispatcher, waited } = build([bad]);

      const [outcome] = await dispatcher.deliver(payload);

      expect(bad.sends).toBe(1);
      expect(waited).toEqual([]);
      expect(outcome).toMatchObject({ status: 'failed', attempts: 1 });
    });
  });

  describe('shouldSend', () => {
    it('skips a channel that declines, without an attempt or a retry', async () => {
      const declining = new FakeChannel('declining', { shouldSend: false });
      const { dispatcher } = build([declining]);

      const [outcome] = await dispatcher.deliver(payload);

      expect(declining.sends).toBe(0);
      expect(outcome).toMatchObject({ status: 'skipped', attempts: 0 });
    });

    it('skips rather than retries a channel that cannot decide', async () => {
      const confused = new FakeChannel('confused', {
        shouldSend: new Error('settings unreadable'),
      });
      const { dispatcher } = build([confused]);

      const [outcome] = await dispatcher.deliver(payload);

      expect(confused.sends).toBe(0);
      expect(outcome.status).toBe('skipped');
    });
  });

  describe('dispatch and drain', () => {
    it('returns before delivery finishes, and drain waits for it', async () => {
      let release!: () => void;
      const slow: INotificationChannel = {
        channel: 'slow',
        shouldSend: () => Promise.resolve(true),
        send: () => new Promise<void>((resolve) => (release = resolve)),
      };

      const { dispatcher } = build([slow]);
      dispatcher.dispatch(payload);

      // Still in flight: the caller was not made to wait on it.
      let drained = false;
      const draining = dispatcher.drain().then(() => (drained = true));
      await Promise.resolve();
      expect(drained).toBe(false);

      release();
      await draining;
      expect(drained).toBe(true);
    });

    it('drains a channel that fails without leaving an unhandled rejection', async () => {
      const dead = new FakeChannel('dead', { failTimes: 99 });
      const { dispatcher } = build([dead]);

      dispatcher.dispatch(payload);
      await expect(dispatcher.drain()).resolves.toBeUndefined();
    });
  });
});
