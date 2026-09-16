import { Injectable } from '@nestjs/common';
import {
  TransportFailure,
  type HttpTransport,
  type TransportRequest,
  type TransportResponse,
} from './transport';

/**
 * The real transport. The only place in the AI layer that touches the network.
 *
 * Deliberately thin: it does not retry, does not interpret status codes, and
 * does not know what a provider is. Status handling belongs to the provider
 * that knows what its own 400 means; retry policy belongs above both.
 */
@Injectable()
export class FetchTransport implements HttpTransport {
  constructor(private readonly timeoutMs = 120_000) {}

  async send(request: TransportRequest): Promise<TransportResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    request.signal?.addEventListener('abort', () => controller.abort());

    try {
      const res = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: controller.signal,
      });

      const text = await res.text();
      let body: unknown = text;
      try {
        body = text ? (JSON.parse(text) as unknown) : null;
      } catch {
        // A gateway's HTML error page, say. Kept as text so the provider can
        // report something useful rather than "unexpected token <".
      }

      return { status: res.status, headers: headersToObject(res.headers), body };
    } catch (e) {
      throw new TransportFailure(
        controller.signal.aborted ? 'request timed out' : 'network request failed',
        e,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async *stream(request: TransportRequest): AsyncIterable<unknown> {
    const controller = new AbortController();
    request.signal?.addEventListener('abort', () => controller.abort());

    let res: Response;
    try {
      res = await fetch(request.url, {
        method: request.method,
        headers: { ...request.headers, Accept: 'text/event-stream' },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: controller.signal,
      });
    } catch (e) {
      throw new TransportFailure('network request failed', e);
    }

    if (!res.ok || !res.body) {
      // Surface the failure as a normal response so the provider's shared
      // status mapping handles it, rather than duplicating that logic here.
      const text = await res.text().catch(() => '');
      throw new TransportFailure(`stream failed with ${res.status}: ${text.slice(0, 200)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line. Anything after the last
        // separator is a partial frame and stays in the buffer.
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
              yield JSON.parse(payload) as unknown;
            } catch {
              // A provider heartbeat or comment frame. Skipping it is correct;
              // throwing would end a stream over a keep-alive.
            }
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => (out[key.toLowerCase()] = value));
  return out;
}
