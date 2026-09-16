/**
 * The HTTP seam under every provider.
 *
 * Providers do not call `fetch` directly. They build a request, hand it to a
 * transport, and interpret what comes back. That single indirection is what
 * makes the contract suite possible: the same tests run against every provider
 * with a scripted transport, no network, no SDK mocking, and no flakiness.
 *
 * It is also where retries, timeouts and request logging belong later, in one
 * place rather than once per provider.
 */

export interface TransportRequest {
  url: string;
  method: 'POST' | 'GET';
  headers: Record<string, string>;
  /**
   * Optional, because a GET has none. FetchTransport already omitted the body
   * when it was undefined; the type said otherwise until the first GET provider
   * (search) arrived and disagreed with it.
   */
  body?: unknown;
  signal?: AbortSignal;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  /** Parsed JSON when the response was JSON, otherwise the raw text. */
  body: unknown;
}

export interface HttpTransport {
  send(request: TransportRequest): Promise<TransportResponse>;
  /** Server-sent events, one decoded `data:` payload at a time. */
  stream(request: TransportRequest): AsyncIterable<unknown>;
}

export const HTTP_TRANSPORT = Symbol('HTTP_TRANSPORT');

/**
 * Thrown for failures below HTTP — DNS, TLS, socket, abort. Providers map it to
 * ProviderUnavailableError so callers never see transport-level types.
 */
export class TransportFailure extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'TransportFailure';
  }
}
