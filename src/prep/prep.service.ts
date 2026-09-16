import { Inject, Injectable, Logger } from '@nestjs/common';
import { JOB_QUEUE, type IJobQueue } from '../core/jobs/job-queue';
import { PREP_REPOSITORY, type IPrepRepository, type PrepDocumentView } from './prep.repository';
import { currentTenant } from '../core/tenancy/tenant.context';

/**
 * The request-path half of prep documents. It enqueues; it never researches.
 *
 * PRD Phase 8 acceptance: "Marking INTERVIEW returns immediately." The only way
 * to keep that true as the product grows is for this class to have no way of
 * doing the work — it holds a queue, not a composer, so an accidental `await`
 * on the research is not something a future edit here can reach.
 */
@Injectable()
export class PrepService {
  private readonly logger = new Logger(PrepService.name);

  constructor(
    @Inject(PREP_REPOSITORY) private readonly repository: IPrepRepository,
    @Inject(JOB_QUEUE) private readonly queue: IJobQueue,
  ) {}

  /**
   * Called when an application moves to INTERVIEW.
   *
   * Idempotent: a second call finds the existing row and enqueues nothing, so
   * clicking twice does not send a finished document back to pending.
   */
  async request(applicationId: string): Promise<PrepDocumentView> {
    const clientId = currentTenant()?.clientId;
    if (!clientId) throw new Error('cannot request a prep document without a tenant');

    const { document, created } = await this.repository.claim(applicationId);
    if (!created) return document;

    // The tenant travels in the payload. A worker runs outside any request and
    // has no context to inherit — it opens its own.
    await this.queue.enqueue('prep-document.generate', { clientId, applicationId });
    this.logger.log(`prep document queued for application ${applicationId}`);

    return document;
  }

  find(applicationId: string): Promise<PrepDocumentView | null> {
    return this.repository.find(applicationId);
  }
}
