import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { IJobQueue, JobName, JobPayloadMap } from './job-queue';

/**
 * Runs jobs in this process, after the response has gone out.
 *
 * ── Why this exists at all ──────────────────────────────────────────────────
 * It is what runs when REDIS_URL is not set, which is every local machine and
 * every CI run. Without it, developing or testing anything downstream of a
 * background job means standing up Redis first, and the usual answer to that is
 * to call the handler inline "just for now" — which is how the request path
 * quietly acquires a thirty-second web search.
 *
 * ── What it is not ──────────────────────────────────────────────────────────
 * It is not durable. A job in flight when the process restarts is gone, with no
 * retry and no dead-letter queue. That is acceptable for a prep document (the
 * Client can ask again) and would not be for anything involving money. The
 * production binding is BullMQ; this one refuses to be selected when
 * REDIS_URL is present, so it cannot be reached by accident.
 */
@Injectable()
export class InProcessQueue implements IJobQueue, OnModuleDestroy {
  private readonly logger = new Logger(InProcessQueue.name);
  private readonly inFlight = new Set<Promise<unknown>>();

  private handlers = new Map<JobName, (payload: unknown) => Promise<void>>();

  register<N extends JobName>(
    name: N,
    handle: (payload: JobPayloadMap[N]) => Promise<void>,
  ): void {
    this.handlers.set(name, handle as (payload: unknown) => Promise<void>);
  }

  enqueue<N extends JobName>(name: N, payload: JobPayloadMap[N]): Promise<void> {
    const handle = this.handlers.get(name);
    if (!handle) {
      // Loud, because a job nobody runs looks exactly like a job that is still
      // running, and the screen waiting on it cannot tell the difference.
      this.logger.error(`no handler registered for job "${name}"`);
      return Promise.resolve();
    }

    // setImmediate, not await: the point is that the caller's response is
    // already on its way out before any of this starts.
    const work = new Promise<void>((resolve) => {
      setImmediate(() => {
        handle(payload)
          .catch((e: unknown) => {
            this.logger.error(`job "${name}" failed: ${describe(e)}`);
          })
          .finally(resolve);
      });
    });

    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));

    return Promise.resolve();
  }

  /** Tests and shutdown. Product code never waits for a job. */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.drain();
  }
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
