import { Injectable, Logger } from '@nestjs/common';
import type { JobHandler, JobName } from './job-queue';

/**
 * Where handlers announce themselves.
 *
 * A multi-provider array would have been the obvious shape — it is what the
 * notification channels use — but it cannot work here. The module holding the
 * array would have to import every feature module that contributes a handler,
 * while each of those needs JOB_QUEUE from it: a cycle.
 *
 * So handlers register in their own `onModuleInit`, and the wiring runs at
 * `onApplicationBootstrap`, which Nest guarantees comes after all of them.
 */
@Injectable()
export class JobRegistry {
  private readonly logger = new Logger(JobRegistry.name);
  private readonly handlers = new Map<JobName, JobHandler<JobName>>();

  register(handler: JobHandler<JobName>): void {
    if (this.handlers.has(handler.name)) {
      // Two handlers for one job name means whichever registered last silently
      // wins, and the other one's work never runs.
      this.logger.error(`duplicate handler for job "${handler.name}"`);
    }
    this.handlers.set(handler.name, handler);
  }

  /**
   * Keyed by JobName rather than string, so the wiring in jobs.module.ts needs
   * no cast back. A cast there would be a cast on the one path that decides
   * which handler runs, which is the worst place to have one.
   */
  asMap(): Map<JobName, (payload: unknown) => Promise<void>> {
    return new Map(
      [...this.handlers].map(([name, handler]) => [
        name,
        (payload: unknown) => handler.handle(payload as never),
      ]),
    );
  }
}
