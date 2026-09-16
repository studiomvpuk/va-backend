import { Injectable } from '@nestjs/common';
import {
  ProviderAuthError,
  ProviderProtocolError,
  ProviderRateLimitError,
  ProviderUnavailableError,
} from './errors';
import { TransportFailure, type HttpTransport } from './transport';
import type { ISearchProvider, SearchResult } from './ai-provider.interface';

const SEARCH_API = 'https://api.search.brave.com/res/v1/web/search';

/**
 * Brave Search.
 *
 * Chosen over scraping a search page for one reason that matters more than
 * price: it returns a URL per result, and the prep document's rule is that
 * every claim in the background section traces to a source the Client can open.
 * An extract with no link is not evidence of anything.
 *
 * Same injected transport as every other provider, so the error mapping is
 * tested against a script rather than against Brave.
 */
@Injectable()
export class BraveSearchProvider implements ISearchProvider {
  readonly name = 'brave';

  constructor(
    private readonly transport: HttpTransport,
    private readonly apiKey: string,
  ) {}

  async search(input: {
    query: string;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<SearchResult[]> {
    const params = new URLSearchParams({
      q: input.query,
      count: String(Math.min(input.limit ?? 5, 20)),
      // No AI summaries: this is a source of citations, not of prose. A
      // generated summary would arrive with no URL attached to it.
      summary: '0',
    });

    let response;
    try {
      response = await this.transport.send({
        url: `${SEARCH_API}?${params.toString()}`,
        method: 'GET',
        headers: {
          accept: 'application/json',
          'x-subscription-token': this.apiKey,
        },
        signal: input.signal,
      });
    } catch (e) {
      if (e instanceof TransportFailure) {
        throw new ProviderUnavailableError(this.name, e.message, e);
      }
      throw e;
    }

    if (response.status === 401 || response.status === 403) {
      throw new ProviderAuthError(this.name, response.body);
    }
    if (response.status === 429) {
      const retryAfter = Number(response.headers['retry-after']);
      throw new ProviderRateLimitError(
        this.name,
        Number.isFinite(retryAfter) ? retryAfter : undefined,
        response.body,
      );
    }
    if (response.status >= 500) {
      throw new ProviderUnavailableError(this.name, `HTTP ${response.status}`, response.body);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new ProviderProtocolError(this.name, `HTTP ${response.status}`, response.body);
    }

    return toResults(response.body);
  }
}

interface BraveResponse {
  web?: {
    results?: {
      title?: string;
      url?: string;
      description?: string;
      age?: string;
      page_age?: string;
    }[];
  };
}

/**
 * No results is an empty array, never an error.
 *
 * A company with no web presence is a normal outcome — plenty of the employers
 * a Client applies to are small — and the caller's job is to write a prep
 * document without a background section, not to fail.
 */
export function toResults(body: unknown): SearchResult[] {
  const results = (body as BraveResponse)?.web?.results;
  if (!Array.isArray(results)) return [];

  return results
    .filter((r) => typeof r?.url === 'string' && r.url.length > 0)
    .map((r) => ({
      title: r.title ?? r.url!,
      url: r.url!,
      snippet: stripTags(r.description ?? ''),
      ...(r.page_age ?? r.age ? { publishedAt: r.page_age ?? r.age } : {}),
    }));
}

/**
 * Brave marks query terms with <strong> in the description.
 *
 * Stripped here rather than downstream, because this text goes into a prompt:
 * leaving markup in it invites a model to treat it as structure, and the
 * untrusted-input wrapper is doing enough work already.
 */
function stripTags(text: string): string {
  return text.replace(/<[^>]*>/g, '').trim();
}
