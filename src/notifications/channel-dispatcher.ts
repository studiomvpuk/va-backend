import { Inject, Injectable, Logger, Optional, OnModuleDestroy } from '@nestjs/common';
import {
  NOTIFICATION_CHANNELS,
  PermanentDeliveryError,
  type ChannelPayload,
  type INotificationChannel,
} from './channels/notification-channel';

export interface ChannelOutcome {
  channel: string;
  status: 'sent' | 'skipped' | 'failed';
  attempts: number;
  error?: string;
}

/** Two retries after the first try, backing off. Tunable, but not per call site. */
export const RETRY_DELAYS_MS = [250, 1_500] as const;

/**
 * The backoff wait, injectable so tests do not spend 1.75 real seconds proving
 * that a retry happened. @Optional, so nothing has to bind it in production.
 */
export const RETRY_SLEEP = Symbol('RETRY_SLEEP');

/**
 * Fans a notification out to every channel, independently.
 *
 * ── The property this class exists to guarantee ──────────────────────────────
 * One channel failing never loses another. Not "usually" — structurally. Every
 * channel runs in its own settled promise, so there is no shared rejection path
 * for a thrown error to escape through and no ordering in which an early
 * failure prevents a later send. A sequential `for` loop with an await inside
 * would have exactly that bug, and it is the obvious way to write this.
 *
 * ── Why dispatch is not awaited by the caller ────────────────────────────────
 * The durable in-app row is already written by the time this runs. Making a VA
 * wait on an SMTP handshake to get a reply in chat would trade a visible,
 * interactive latency for a delivery that is best-effort anyway. So dispatch is
 * scheduled, and `drain()` exists so tests are deterministic and shutdown does
 * not drop queued sends on the floor.
 */
@Injectable()
export class ChannelDispatcher implements OnModuleDestroy {
  private readonly logger = new Logger(ChannelDispatcher.name);
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(
    @Inject(NOTIFICATION_CHANNELS) private readonly channels: INotificationChannel[],
    @Optional()
    @Inject(RETRY_SLEEP)
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {}

  /** Schedules delivery and returns immediately. */
  dispatch(payload: ChannelPayload): void {
    const work = this.deliver(payload).catch((e: unknown) => {
      // Unreachable: deliver() settles every channel. Belt and braces, because
      // an unhandled rejection here would take the process down.
      this.logger.error(`dispatch escaped its own error handling: ${describe(e)}`);
      return [];
    });

    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));
  }

  /** Waits for everything currently scheduled. Tests and shutdown only. */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.drain();
  }

  /** Exposed for the notification service's synchronous-delivery tests. */
  async deliver(payload: ChannelPayload): Promise<ChannelOutcome[]> {
    const results = await Promise.allSettled(
      this.channels.map((channel) => this.deliverOne(channel, payload)),
    );

    return results.map((result, i) =>
      result.status === 'fulfilled'
        ? result.value
        : {
            channel: this.channels[i]?.channel ?? 'unknown',
            status: 'failed' as const,
            attempts: 0,
            error: describe(result.reason),
          },
    );
  }

  private async deliverOne(
    channel: INotificationChannel,
    payload: ChannelPayload,
  ): Promise<ChannelOutcome> {
    let wanted: boolean;
    try {
      wanted = await channel.shouldSend(payload);
    } catch (e) {
      // A channel that cannot decide is skipped, not retried. Asking it again
      // will produce the same answer.
      this.logger.warn(`${channel.channel}: shouldSend failed: ${describe(e)}`);
      return { channel: channel.channel, status: 'skipped', attempts: 0, error: describe(e) };
    }

    if (!wanted) return { channel: channel.channel, status: 'skipped', attempts: 0 };

    let lastError = '';
    for (let attempt = 1; attempt <= RETRY_DELAYS_MS.length + 1; attempt++) {
      try {
        await channel.send(payload);
        return { channel: channel.channel, status: 'sent', attempts: attempt };
      } catch (e) {
        lastError = describe(e);

        if (e instanceof PermanentDeliveryError) {
          this.logger.warn(`${channel.channel}: permanent failure, not retrying: ${lastError}`);
          return {
            channel: channel.channel,
            status: 'failed',
            attempts: attempt,
            error: lastError,
          };
        }

        const delay = RETRY_DELAYS_MS[attempt - 1];
        if (delay === undefined) break;
        await this.sleep(delay);
      }
    }

    // The in-app row is already stored, so the Client still sees this the next
    // time they open the app. That is why giving up here is acceptable.
    this.logger.warn(
      `${channel.channel}: giving up after ${RETRY_DELAYS_MS.length + 1} attempts: ${lastError}`,
    );
    return {
      channel: channel.channel,
      status: 'failed',
      attempts: RETRY_DELAYS_MS.length + 1,
      error: lastError,
    };
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
