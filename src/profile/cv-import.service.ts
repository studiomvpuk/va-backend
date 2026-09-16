import { Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { ProviderFactory } from '../ai/provider-factory';
import { RateLimitService } from '../ratelimit/rate-limit.service';
import { getPrompt, asUntrustedInput, promptVersionTag } from '../ai/prompts/prompt-registry';
import { detectGovernmentId } from './validation/government-id';
import { currentTenant } from '../core/tenancy/tenant.context';
import { ProviderError } from '../ai/providers/errors';

export interface SuggestedField {
  key: string;
  label: string;
  value: string;
  suggestedVisibility: 'GENERAL' | 'SENSITIVE';
}

export interface CvSuggestions {
  narrative: string;
  fields: SuggestedField[];
  /** Which prompt produced this, for reproducibility. */
  promptVersion: string;
  /** Fields the model proposed that were dropped, and why. */
  dropped: { label: string; reason: string }[];
}

/**
 * Turns CV text into profile fields for the Client to confirm.
 *
 * Deferred here from Phase 2 deliberately: this needs a model, and the provider
 * seam did not exist until now. Building it earlier would have meant a direct
 * provider call bypassing ITextGenerator — the exact coupling this phase exists
 * to prevent.
 *
 * Nothing it produces is saved. Every field is a suggestion the Client accepts
 * or discards, because a model reading a CV gets things subtly wrong and the
 * person whose CV it is should be the one to notice.
 */
@Injectable()
export class CvImportService {
  constructor(
    private readonly providers: ProviderFactory,
    @Inject(RateLimitService) private readonly limits: RateLimitService,
  ) {}

  async suggestFrom(cvText: string): Promise<CvSuggestions> {
    const clientId = currentTenant()?.clientId;
    if (!clientId) throw new Error('No tenant context for CV import');
    if (cvText.trim().length < 50) {
      throw new UnprocessableEntityException(
        'That is too short to read as a CV. Paste the full text, or type your ' +
          'experience into the profile directly.',
      );
    }

    await this.limits.consumeClientAiCall(clientId);

    const prompt = getPrompt('cv.extract_fields');
    const generator = await this.providers.textGenerator();

    let raw: string;
    try {
      const result = await generator.generate({
        system: prompt.system,
        maxTokens: 4096,
        temperature: 0,
        messages: [{ role: 'user', content: asUntrustedInput('cv', cvText) }],
      });
      raw = result.text;
    } catch (e) {
      // Normalised provider errors carry a usable message; anything else does
      // not, so it does not reach the Client.
      if (e instanceof ProviderError) {
        throw new UnprocessableEntityException(
          `Could not read the CV: ${e.message}${e.retryable ? ' Try again shortly.' : ''}`,
        );
      }
      throw e;
    }

    return this.parse(raw, promptVersionTag('cv.extract_fields'));
  }

  private parse(raw: string, promptVersion: string): CvSuggestions {
    const parsed = extractJson(raw);
    if (!parsed) {
      throw new UnprocessableEntityException(
        'Could not make sense of that CV. Try pasting the plain text, or fill ' +
          'the profile in directly.',
      );
    }

    const dropped: { label: string; reason: string }[] = [];
    const fields: SuggestedField[] = [];

    for (const candidate of parsed.fields ?? []) {
      if (!candidate?.key || !candidate.label || typeof candidate.value !== 'string') {
        continue;
      }

      // The prompt tells the model not to propose government IDs. This is what
      // happens when it does anyway — the storage layer would refuse it, but a
      // rejected save after the Client clicked "accept" is a worse experience
      // than never offering it.
      const match = detectGovernmentId(candidate.value, candidate.label);
      if (match) {
        dropped.push({
          label: candidate.label,
          reason: `looked like ${match.label}, which this system never stores`,
        });
        continue;
      }

      fields.push({
        key: normaliseKey(candidate.key),
        label: candidate.label.slice(0, 120),
        value: candidate.value.slice(0, 4000),
        suggestedVisibility:
          candidate.suggestedVisibility === 'SENSITIVE' ? 'SENSITIVE' : 'GENERAL',
      });
    }

    return {
      narrative: (parsed.narrative ?? '').slice(0, 20_000),
      fields,
      promptVersion,
      dropped,
    };
  }
}

interface ParsedSuggestions {
  narrative?: string;
  fields?: {
    key?: string;
    label?: string;
    value?: string;
    suggestedVisibility?: string;
  }[];
}

/**
 * Pulls the JSON object out of a model response.
 *
 * Models wrap JSON in prose or fences more often than they should, and failing
 * the whole import over a stray "Here's the result:" would be a poor trade.
 */
function extractJson(raw: string): ParsedSuggestions | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const candidates = [fenced?.[1], raw].filter(Boolean) as string[];

  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) continue;
    try {
      return JSON.parse(candidate.slice(start, end + 1)) as ParsedSuggestions;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function normaliseKey(key: string): string {
  return (
    key
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 64) || 'field'
  );
}
