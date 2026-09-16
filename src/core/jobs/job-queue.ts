/**
 * Enqueueing work, without knowing what runs it.
 *
 * PRD Phase 8: "Status change to INTERVIEW enqueues a background research job
 * — off the request path, because web research is slow and must not block the
 * tracker."
 *
 * The interface is deliberately thinner than BullMQ's. Callers get `enqueue`
 * and nothing else: no progress, no priorities, no job handles. Everything a
 * caller could reach for there is a reason for product code to start waiting on
 * a job, which is the exact thing this seam exists to prevent.
 */

export interface JobPayloadMap {
  /**
   * Research and compose one interview prep document.
   *
   * The tenant is carried explicitly. A worker runs outside any request, so
   * there is no AsyncLocalStorage context to inherit — it has to open one, and
   * a payload that did not name the Client would make that impossible.
   */
  'prep-document.generate': {
    clientId: string;
    applicationId: string;
  };
}

export type JobName = keyof JobPayloadMap;

export interface IJobQueue {
  enqueue<N extends JobName>(name: N, payload: JobPayloadMap[N]): Promise<void>;
}

export interface JobHandler<N extends JobName> {
  readonly name: N;
  handle(payload: JobPayloadMap[N]): Promise<void>;
}

export const JOB_QUEUE = Symbol('JOB_QUEUE');
export const JOB_HANDLERS = Symbol('JOB_HANDLERS');
