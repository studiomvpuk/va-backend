import { Inject, Injectable, Logger } from '@nestjs/common';
import { ProviderFactory } from '../ai/provider-factory';
import {
  SEARCH_PROVIDER,
  type ISearchProvider,
  type SearchResult,
} from '../ai/providers/ai-provider.interface';
import { asUntrustedInput, getPrompt } from '../ai/prompts/prompt-registry';
import {
  validatePrep,
  type Evidence,
  type PrepProposal,
  type ValidatedPrep,
} from './prep-validation';

/** Enough for a paragraph; more is prompt cost for diminishing returns. */
const MAX_RESULTS = 6;

export class PrepCompositionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrepCompositionError';
  }
}

/**
 * Research a company, then write the document — with everything checked.
 *
 * The search runs first and its results are the ONLY company material the model
 * sees. It is not asked to "use search results where available"; there is
 * nothing else in the prompt to fall back on, and then `validatePrep` throws
 * away anything it produced that does not point back at them.
 */
@Injectable()
export class PrepComposer {
  private readonly logger = new Logger(PrepComposer.name);

  constructor(
    private readonly providers: ProviderFactory,
    @Inject(SEARCH_PROVIDER) private readonly search: ISearchProvider,
  ) {}

  async compose(input: {
    companyName: string;
    roleTitle: string;
    jobDescription: string;
    profileContext: string;
    profileFieldKeys: string[];
    hasNarrative: boolean;
  }): Promise<ValidatedPrep> {
    const results = await this.research(input.companyName, input.roleTitle);

    const generator = await this.providers.textGenerator('ANTHROPIC');
    const prompt = getPrompt('prep.compose');

    const result = await generator.generate({
      system: prompt.system,
      cacheablePrefix: input.profileContext,
      maxTokens: 3072,
      temperature: 0.4,
      messages: [
        {
          role: 'user',
          content: [
            `Role: ${input.roleTitle} at ${input.companyName}`,
            asUntrustedInput('job_description', input.jobDescription),
            asUntrustedInput('search_results', formatResults(results)),
            `Profile field keys available for citation: ${
              input.profileFieldKeys.join(', ') || '(none)'
            }`,
            `Experience narrative available: ${input.hasNarrative ? 'yes' : 'no'}`,
          ].join('\n\n'),
        },
      ],
    });

    const evidence: Evidence = {
      profileFieldKeys: new Set(input.profileFieldKeys),
      hasNarrative: input.hasNarrative,
      sourceUrls: new Set(results.map((r) => r.url)),
    };

    const validated = validatePrep(parseProposal(result.text), evidence);

    if (validated.discarded.length > 0) {
      // Worth a line each: a model that suddenly starts citing fields nobody
      // has is the earliest signal that a prompt change went wrong.
      this.logger.warn(
        `prep for ${input.companyName}: discarded ${validated.discarded.length} unattributable item(s)`,
      );
      for (const reason of validated.discarded) this.logger.debug(reason);
    }

    return validated;
  }

  /**
   * Two queries, not one.
   *
   * The company name alone pulls the homepage and directory listings; adding
   * the role pulls whatever is being said about working there. A single query
   * reliably gets one or the other, and which one it gets depends on how
   * generic the company's name is.
   *
   * A failing search is not a failing document — it is the no-background case,
   * which is already a supported outcome.
   */
  private async research(companyName: string, roleTitle: string): Promise<SearchResult[]> {
    const queries = [companyName, `${companyName} ${roleTitle} company`];

    const settled = await Promise.allSettled(
      queries.map((query) => this.search.search({ query, limit: MAX_RESULTS })),
    );

    const seen = new Set<string>();
    const results: SearchResult[] = [];

    for (const outcome of settled) {
      if (outcome.status === 'rejected') {
        this.logger.warn(`company search failed: ${describe(outcome.reason)}`);
        continue;
      }
      for (const result of outcome.value) {
        if (seen.has(result.url)) continue;
        seen.add(result.url);
        results.push(result);
      }
    }

    return results.slice(0, MAX_RESULTS);
  }
}

export function formatResults(results: SearchResult[]): string {
  if (results.length === 0) {
    // Said explicitly rather than left as an empty block, because an empty
    // section reads as "omitted" and invites the model to fill it in.
    return 'No search results were found for this company. There is no company background available.';
  }

  return results
    .map((r) => [`url: ${r.url}`, `title: ${r.title}`, `extract: ${r.snippet}`].join('\n'))
    .join('\n\n');
}

export function parseProposal(raw: string): PrepProposal {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new PrepCompositionError('no JSON object in the response');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new PrepCompositionError('response was not valid JSON');
  }

  const record = parsed as Record<string, unknown>;
  return {
    background: typeof record.background === 'string' ? record.background : null,
    backgroundSourceUrls: asStringArray(record.backgroundSourceUrls),
    questions: Array.isArray(record.questions)
      ? (record.questions as PrepProposal['questions'])
      : [],
    talkingPoints: Array.isArray(record.talkingPoints)
      ? (record.talkingPoints as PrepProposal['talkingPoints'])
      : [],
  };
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
