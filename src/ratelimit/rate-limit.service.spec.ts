import { LIMITS, RateLimitExceeded, RateLimitService } from './rate-limit.service';
import { MemoryRateLimitStore } from './memory-rate-limit.store';

describe('RateLimitService', () => {
  let store: MemoryRateLimitStore;
  let service: RateLimitService;

  beforeEach(() => {
    store = new MemoryRateLimitStore();
    service = new RateLimitService(store);
  });

  describe('per-VA messages', () => {
    it('allows up to the limit', async () => {
      for (let i = 0; i < LIMITS.vaMessagesPerMinute; i++) {
        await expect(service.consumeVaMessage('va_1')).resolves.toBeUndefined();
      }
    });

    it('refuses the one after', async () => {
      for (let i = 0; i < LIMITS.vaMessagesPerMinute; i++) {
        await service.consumeVaMessage('va_1');
      }
      await expect(service.consumeVaMessage('va_1')).rejects.toBeInstanceOf(
        RateLimitExceeded,
      );
    });

    it('counts each VA separately', async () => {
      for (let i = 0; i < LIMITS.vaMessagesPerMinute; i++) {
        await service.consumeVaMessage('va_1');
      }
      await expect(service.consumeVaMessage('va_2')).resolves.toBeUndefined();
    });

    it('says what to do, not just that something failed', async () => {
      for (let i = 0; i < LIMITS.vaMessagesPerMinute; i++) {
        await service.consumeVaMessage('va_1');
      }
      const error = await service.consumeVaMessage('va_1').catch((e: RateLimitExceeded) => e);
      const body = (error as RateLimitExceeded).getResponse() as { message: string };

      expect(body.message).toMatch(/wait \d+ seconds/i);
      // The VA needs to know their work is not lost, or they will retype it.
      expect(body.message).toMatch(/nothing has been lost/i);
      expect((error as RateLimitExceeded).getStatus()).toBe(429);
    });

    it('carries a retry-after a client can act on', async () => {
      for (let i = 0; i < LIMITS.vaMessagesPerMinute; i++) {
        await service.consumeVaMessage('va_1');
      }
      const error = await service.consumeVaMessage('va_1').catch((e: RateLimitExceeded) => e);
      expect((error as RateLimitExceeded).retryAfterSeconds).toBeGreaterThan(0);
      expect((error as RateLimitExceeded).retryAfterSeconds).toBeLessThanOrEqual(60);
    });
  });

  describe('per-Client daily AI calls', () => {
    it('charges more than one call when a request costs more than one', async () => {
      // GPT drafts, Claude refines: two provider calls, one VA request.
      await service.consumeClientAiCall('client_1', 2);
      const status = await service.statusForClient('client_1');
      expect(status.used).toBe(2);
    });

    it('refuses once the daily allowance is gone', async () => {
      await service.consumeClientAiCall('client_1', LIMITS.clientAiCallsPerDay);
      await expect(service.consumeClientAiCall('client_1')).rejects.toBeInstanceOf(
        RateLimitExceeded,
      );
    });

    it('explains the cap exists to stop a bug running up a bill', async () => {
      await service.consumeClientAiCall('client_1', LIMITS.clientAiCallsPerDay);
      const error = await service
        .consumeClientAiCall('client_1')
        .catch((e: RateLimitExceeded) => e);
      const body = (error as RateLimitExceeded).getResponse() as { message: string };
      expect(body.message).toMatch(/quietly run up a bill/i);
    });

    it('counts each Client separately', async () => {
      await service.consumeClientAiCall('client_1', LIMITS.clientAiCallsPerDay);
      await expect(service.consumeClientAiCall('client_2')).resolves.toBeUndefined();
    });

    it('reports usage without consuming any', async () => {
      await service.consumeClientAiCall('client_1', 5);
      await service.statusForClient('client_1');
      const after = await service.statusForClient('client_1');
      expect(after.used).toBe(5);
    });
  });
});

describe('MemoryRateLimitStore', () => {
  it('starts a fresh window once the old one expires', async () => {
    const store = new MemoryRateLimitStore();
    await store.hit('k', 1, 20);
    const blocked = await store.hit('k', 1, 20);
    expect(blocked.allowed).toBe(false);

    await new Promise((r) => setTimeout(r, 30));
    const fresh = await store.hit('k', 1, 20);
    expect(fresh.allowed).toBe(true);
    expect(fresh.used).toBe(1);
  });

  it('peek does not increment', async () => {
    const store = new MemoryRateLimitStore();
    await store.hit('k', 5, 1000);
    expect((await store.peek('k', 5, 1000)).used).toBe(1);
    expect((await store.peek('k', 5, 1000)).used).toBe(1);
  });

  it('peek on an unknown key reports zero rather than throwing', async () => {
    const store = new MemoryRateLimitStore();
    expect((await store.peek('never-seen', 5, 1000)).used).toBe(0);
  });

  it('reset clears the window', async () => {
    const store = new MemoryRateLimitStore();
    await store.hit('k', 1, 1000);
    await store.reset('k');
    expect((await store.hit('k', 1, 1000)).allowed).toBe(true);
  });
});
