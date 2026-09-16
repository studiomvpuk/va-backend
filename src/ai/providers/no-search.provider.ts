import { Injectable, Logger } from '@nestjs/common';
import type { ISearchProvider, SearchResult } from './ai-provider.interface';

/**
 * What runs when BRAVE_SEARCH_API_KEY is not set.
 *
 * It returns nothing, which is a real answer rather than a placeholder: the
 * composer's behaviour for "no findable company information" is already
 * specified — questions and talking points, no invented background — and this
 * is exactly that case. So the degradation path is not a rarely-exercised
 * branch; it is what every developer and every CI run uses by default.
 *
 * A null object rather than a missing binding, so nothing downstream needs a
 * `searchProvider?` or a null check that someone will eventually forget.
 */
@Injectable()
export class NoSearchProvider implements ISearchProvider {
  readonly name = 'none';
  private readonly logger = new Logger(NoSearchProvider.name);
  private warned = false;

  search(): Promise<SearchResult[]> {
    if (!this.warned) {
      // Once, not per call: a prep document issues several searches and the log
      // should not be the loudest thing about a missing optional key.
      this.warned = true;
      this.logger.warn(
        'No BRAVE_SEARCH_API_KEY — prep documents will have no company background.',
      );
    }
    return Promise.resolve([]);
  }
}
