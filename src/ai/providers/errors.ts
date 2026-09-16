/**
 * Normalised provider failures.
 *
 * PRD §2.4 (Liskov): every ITextGenerator must be substitutable, which means
 * failures have to look the same too. A caller that has to know whether it is
 * talking to Anthropic or OpenAI in order to handle a rate limit is not using
 * an interface, it is using two.
 *
 * So each provider maps its own error vocabulary onto these, and the shared
 * contract suite asserts they all do it identically.
 */

export abstract class ProviderError extends Error {
  abstract readonly kind: string;
  /** Worth trying again unchanged? */
  abstract readonly retryable: boolean;

  constructor(
    message: string,
    readonly provider: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** 429, or a provider-specific overload signal. */
export class ProviderRateLimitError extends ProviderError {
  readonly kind = 'rate_limit';
  readonly retryable = true;

  constructor(
    provider: string,
    /** Seconds to wait, when the provider said. */
    readonly retryAfterSeconds?: number,
    cause?: unknown,
  ) {
    super(
      `${provider} is rate limiting this request` +
        (retryAfterSeconds ? `; retry in ${retryAfterSeconds}s` : ''),
      provider,
      cause,
    );
  }
}

/** 401/403 — a bad, revoked or unfunded key. Retrying will not help. */
export class ProviderAuthError extends ProviderError {
  readonly kind = 'auth';
  readonly retryable = false;

  constructor(provider: string, cause?: unknown) {
    super(
      `${provider} rejected the API key. If this is your own key, check it is ` +
        `valid and has credit.`,
      provider,
      cause,
    );
  }
}

/** The provider refused the content itself. Retrying the same input will not help. */
export class ProviderContentError extends ProviderError {
  readonly kind = 'content';
  readonly retryable = false;

  constructor(provider: string, readonly detail: string, cause?: unknown) {
    super(`${provider} refused this request: ${detail}`, provider, cause);
  }
}

/** 5xx, a timeout, or a socket failure. Transient by assumption. */
export class ProviderUnavailableError extends ProviderError {
  readonly kind = 'unavailable';
  readonly retryable = true;

  constructor(provider: string, readonly detail: string, cause?: unknown) {
    super(`${provider} is unavailable: ${detail}`, provider, cause);
  }
}

/** A malformed or unparseable response. Not the caller's fault, not retryable. */
export class ProviderProtocolError extends ProviderError {
  readonly kind = 'protocol';
  readonly retryable = false;

  constructor(provider: string, readonly detail: string, cause?: unknown) {
    super(`${provider} returned an unexpected response: ${detail}`, provider, cause);
  }
}

export function isProviderError(e: unknown): e is ProviderError {
  return e instanceof ProviderError;
}
