import { Injectable } from '@nestjs/common';
import { ProviderFactory } from '../ai/provider-factory';
import { asUntrustedInput, getPrompt } from '../ai/prompts/prompt-registry';
import type { AnswerConfidence, GapSignal } from './gap-resolution';

/**
 * The model could not be understood.
 *
 * Deliberately NOT treated as a gap. A gap with an empty best-effort answer
 * would, in GUESS_AND_PROCEED mode, put an empty string into a real job
 * application and tell the Client it was answered for them. Failing loudly and
 * letting the VA retry is the only honest option.
 */
export class GapDetectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GapDetectionError';
  }
}

/**
 * Asks the model to answer a question the profile may not cover, and to say how
 * much it had to invent doing so.
 *
 * The confidence and assumption come from the model; whether they amount to a
 * gap is decided in code by `isGenuineGap`. That split is the same one used for
 * disclosure — the model proposes, code decides — and it is what stops a
 * chatty or a hedging model from changing the product's behaviour.
 */
@Injectable()
export class GapDetector {
  constructor(private readonly providers: ProviderFactory) {}

  async detect(input: {
    questionText: string;
    profileContext: string;
    companyName: string;
    roleTitle: string;
  }): Promise<GapSignal> {
    const generator = await this.providers.textGenerator('ANTHROPIC');
    const prompt = getPrompt('gap.best_effort');

    const result = await generator.generate({
      system: prompt.system,
      cacheablePrefix: input.profileContext,
      maxTokens: 1024,
      temperature: 0.3,
      messages: [
        {
          role: 'user',
          content: [
            `Role: ${input.roleTitle} at ${input.companyName}`,
            asUntrustedInput('screening_question', input.questionText),
          ].join('\n\n'),
        },
      ],
    });

    return parseSignal(result.text);
  }
}

export function parseSignal(raw: string): GapSignal {
  const json = extractJson(raw);
  if (!json) throw new GapDetectionError('no JSON object in the response');

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new GapDetectionError('response was not valid JSON');
  }

  const record = parsed as Record<string, unknown>;
  const answer = record.answer;
  if (typeof answer !== 'string' || answer.trim().length === 0) {
    throw new GapDetectionError('response had no answer');
  }

  return {
    bestEffortAnswer: answer.trim(),
    // An unrecognised confidence becomes 'low', which makes it a gap and puts
    // it in front of the Client. Erring toward one extra question beats erring
    // toward a silent guess.
    confidence: toConfidence(record.confidence),
    assumption: typeof record.assumption === 'string' ? record.assumption.trim() : '',
  };
}

function toConfidence(value: unknown): AnswerConfidence {
  return value === 'high' || value === 'medium' ? value : 'low';
}

/** Models wrap JSON in prose and fences more often than anyone would like. */
function extractJson(raw: string): string | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  return start >= 0 && end > start ? raw.slice(start, end + 1) : null;
}
