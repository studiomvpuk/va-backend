import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { IJobQueue, JobName, JobPayloadMap } from './job-queue';

const QUEUE_NAME = 'jaa';

/**
 * The production binding. Redis-backed, survives a restart, retries.
 *
 * ── Retry policy ────────────────────────────────────────────────────────────
 * Three attempts, exponential from two seconds. Web search fails transiently
 * far more often than it fails permanently — a rate limit, a slow upstream, a
 * blip — and the Client is not sitting waiting, so patience costs nothing here
 * in a way it would not on a request path.
 *
 * `removeOnComplete` is bounded rather than true: keeping the last few hundred
 * completed jobs is what makes "did this actually run?" answerable at 2am
 * without adding logging for it. Failures are kept far longer, because that is
 * the question people actually ask.
 */
@Injectable()
export class BullMqQueue implements IJobQueue, OnModuleDestroy {
  private readonly logger = new Logger(BullMqQueue.name);
  private readonly queue: Queue;
  private worker: Worker | null = null;

  constructor(private readonly connection: ConnectionOptions) {
    this.queue = new Queue(QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 5_000 },
      },
    });
  }

  async enqueue<N extends JobName>(name: N, payload: JobPayloadMap[N]): Promise<void> {
    await this.queue.add(name, payload);
  }

  /**
   * Starts consuming.
   *
   * Separate from the constructor so a process can enqueue without also
   * processing — which is what lets the API and the workers scale apart later
   * without any code change beyond not calling this.
   */
  startWorker(handlers: Map<JobName, (payload: unknown) => Promise<void>>): void {
    this.worker = new Worker(
      QUEUE_NAME,
      async (job) => {
        const handle = handlers.get(job.name as JobName);
        if (!handle) {
          // Throwing rather than returning: an unhandled job name means a
          // deploy is mid-flight or a handler was dropped, and the retry gives
          // the rest of the rollout time to arrive.
          throw new Error(`no handler registered for job "${job.name}"`);
        }
        await handle(job.data);
      },
      { connection: this.connection, concurrency: 4 },
    );

    this.worker.on('failed', (job, error) => {
      this.logger.error(
        `job "${job?.name ?? 'unknown'}" failed (attempt ${job?.attemptsMade ?? 0}): ${error.message}`,
      );
    });
  }

  async onModuleDestroy(): Promise<void> {
    // Close the worker first: it stops taking new jobs and lets the ones in
    // hand finish, instead of them being marked stalled and re-run.
    await this.worker?.close();
    await this.queue.close();
  }
}
