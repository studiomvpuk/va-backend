import { Injectable } from '@nestjs/common';
import type { IRateLimitStore, RateLimitDecision } from './rate-limit.store';

interface Window {
  count: number;
  startedAt: number;
}

/**
 * Fixed-window counters in process memory.
 *
 * A fixed window rather than a sliding one: at these limits the boundary effect
 * (up to 2x the limit across a window edge) is irrelevant, and a sliding window
 * costs a sorted set per key for no benefit anyone would notice.
 */
@Injectable()
export class MemoryRateLimitStore implements IRateLimitStore {
  private readonly windows = new Map<string, Window>();
  private lastSweep = Date.now();

  async hit(key: string, limit: number, windowMs: number): Promise<RateLimitDecision> {
    this.sweep(windowMs);
    const now = Date.now();
    const window = this.currentWindow(key, now, windowMs);

    window.count += 1;
    return this.decide(window, limit, windowMs, now);
  }

  async peek(key: string, limit: number, windowMs: number): Promise<RateLimitDecision> {
    const now = Date.now();
    const existing = this.windows.get(key);
    const window =
      existing && now - existing.startedAt < windowMs
        ? existing
        : { count: 0, startedAt: now };
    return this.decide(window, limit, windowMs, now);
  }

  async reset(key: string): Promise<void> {
    this.windows.delete(key);
  }

  private currentWindow(key: string, now: number, windowMs: number): Window {
    const existing = this.windows.get(key);
    if (existing && now - existing.startedAt < windowMs) return existing;
    const fresh = { count: 0, startedAt: now };
    this.windows.set(key, fresh);
    return fresh;
  }

  private decide(
    window: Window,
    limit: number,
    windowMs: number,
    now: number,
  ): RateLimitDecision {
    const resetsAtMs = window.startedAt + windowMs;
    return {
      allowed: window.count <= limit,
      used: window.count,
      limit,
      resetsAt: new Date(resetsAtMs),
      retryAfterSeconds: Math.max(1, Math.ceil((resetsAtMs - now) / 1000)),
    };
  }

  /** Drops expired windows so a long-running process does not grow unbounded. */
  private sweep(windowMs: number): void {
    const now = Date.now();
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [key, window] of this.windows) {
      if (now - window.startedAt > windowMs * 2) this.windows.delete(key);
    }
  }
}
