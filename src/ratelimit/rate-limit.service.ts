import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { RATE_LIMIT_STORE, type IRateLimitStore } from './rate-limit.store';

/**
 * PRD §7.5: "Sensible starting limits (adjustable later): a cap on
 * messages-per-minute per VA account, and a cap on total daily AI calls per
 * Client, with a clear in-app message if a limit is hit rather than a silent
 * failure."
 *
 * These protect two different things. The per-VA minute limit protects the app
 * from one assistant hammering it. The per-Client daily limit protects the
 * Client's wallet from a bug in ours — a runaway loop on someone's own BYOK key
 * is their money.
 */
export const LIMITS = {
  /** Chat messages a single VA may send. */
  vaMessagesPerMinute: 20,
  /** AI calls charged to one Client in a day, across all their VAs. */
  clientAiCallsPerDay: 500,
} as const;

const MINUTE = 60_000;
const DAY = 86_400_000;

export interface LimitStatus {
  used: number;
  limit: number;
  resetsAt: Date;
}

@Injectable()
export class RateLimitService {
  constructor(@Inject(RATE_LIMIT_STORE) private readonly store: IRateLimitStore) {}

  async consumeVaMessage(vaId: string): Promise<void> {
    const decision = await this.store.hit(
      `va:${vaId}:messages`,
      LIMITS.vaMessagesPerMinute,
      MINUTE,
    );
    if (!decision.allowed) {
      throw new RateLimitExceeded(
        `You are sending messages faster than this account allows ` +
          `(${decision.limit} a minute). Wait ${decision.retryAfterSeconds} seconds ` +
          `and carry on — nothing has been lost.`,
        decision.retryAfterSeconds,
      );
    }
  }

  async consumeClientAiCall(clientId: string, calls = 1): Promise<void> {
    let decision = await this.store.hit(
      `client:${clientId}:ai`,
      LIMITS.clientAiCallsPerDay,
      DAY,
    );
    // A single request can cost more than one provider call (GPT drafts, then
    // Claude refines). Charging both keeps the cap honest.
    for (let i = 1; i < calls; i++) {
      decision = await this.store.hit(
        `client:${clientId}:ai`,
        LIMITS.clientAiCallsPerDay,
        DAY,
      );
    }

    if (!decision.allowed) {
      throw new RateLimitExceeded(
        `This account has used its daily allowance of ${decision.limit} AI ` +
          `requests. It resets at ${decision.resetsAt.toISOString()}. If you need ` +
          `a higher limit, raise it in settings — the cap exists so a bug cannot ` +
          `quietly run up a bill.`,
        decision.retryAfterSeconds,
      );
    }
  }

  async statusForClient(clientId: string): Promise<LimitStatus> {
    const d = await this.store.peek(
      `client:${clientId}:ai`,
      LIMITS.clientAiCallsPerDay,
      DAY,
    );
    return { used: d.used, limit: d.limit, resetsAt: d.resetsAt };
  }
}

/**
 * 429 with a Retry-After header and a message written for the person reading it.
 *
 * "Rather than a silent failure" is the requirement, and a bare 429 with
 * `{"statusCode":429}` is a silent failure with extra steps.
 */
export class RateLimitExceeded extends HttpException {
  constructor(message: string, readonly retryAfterSeconds: number) {
    super(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        error: 'Too Many Requests',
        message,
        retryAfterSeconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
