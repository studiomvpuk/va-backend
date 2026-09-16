/**
 * Counter storage for rate limits.
 *
 * In-memory today; Redis in Phase 10. The interface exists now precisely so
 * that swap is a new class rather than a refactor — and so the limits are
 * testable without standing anything up.
 *
 * Worth being honest about the in-memory implementation: it counts per process.
 * With one API instance that is exactly right. With several behind a load
 * balancer, each enforces the limit separately, so the effective limit is
 * multiplied by the instance count. That is a reason to move to Redis before
 * scaling out, not a reason to delay shipping the limits.
 */
export interface RateLimitDecision {
  allowed: boolean;
  /** Requests used in the current window. */
  used: number;
  limit: number;
  /** When the window resets. */
  resetsAt: Date;
  retryAfterSeconds: number;
}

export interface IRateLimitStore {
  /** Increments and reports. Atomic with respect to concurrent callers. */
  hit(key: string, limit: number, windowMs: number): Promise<RateLimitDecision>;
  /** Reads without incrementing — for showing usage in the dashboard. */
  peek(key: string, limit: number, windowMs: number): Promise<RateLimitDecision>;
  reset(key: string): Promise<void>;
}

export const RATE_LIMIT_STORE = Symbol('RATE_LIMIT_STORE');
