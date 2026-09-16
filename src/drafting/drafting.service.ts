import { Injectable } from '@nestjs/common';
import { ProviderFactory } from '../ai/provider-factory';
import {
  asUntrustedInput,
  getPrompt,
  promptVersionTag,
  type PromptId,
} from '../ai/prompts/prompt-registry';
import { checkAts, type AtsReport } from './ats-check';
import {
  chooseOrchestrationPath,
  type ContextFacts,
  type OrchestrationPath,
} from './orchestration-rule';

export type DraftKind = 'CV' | 'COVER_LETTER' | 'SCREENING_ANSWER';

const PROMPT_FOR: Record<DraftKind, PromptId> = {
  CV: 'draft.cv',
  COVER_LETTER: 'draft.cover_letter',
  SCREENING_ANSWER: 'draft.screening_answer',
};

export interface DraftRequest {
  kind: DraftKind;
  /** The screening question, for SCREENING_ANSWER. */
  questionText?: string;
  jobTitle: string;
  companyName: string;
  jobDescription: string;
  /** The stable, cacheable part: profile plus confirmed answers. */
  profileContext: string;
  /** From the seniority calibration. Goes in verbatim. */
  seniorityDirective: string;
  facts: ContextFacts;
}

export interface DraftResult {
  body: string;
  orchestrationPath: OrchestrationPath;
  routingReasons: string[];
  promptVersion: string;
  ats: AtsReport;
}

const MAX_TOKENS: Record<DraftKind, number> = {
  CV: 4096,
  COVER_LETTER: 2048,
  SCREENING_ANSWER: 1024,
};

/**
 * Produces one finished answer (PRD §5.5a).
 *
 * "No dual-model comparison, no VA choice between drafts — the VA gets one
 *  finished answer."
 *
 * Which models are involved is decided by `chooseOrchestrationPath`, in code,
 * before any call is made. This class executes that decision; it does not make
 * it, and it cannot change its mind partway.
 */
@Injectable()
export class DraftingService {
  constructor(private readonly providers: ProviderFactory) {}

  async draft(request: DraftRequest): Promise<DraftResult> {
    const routing = chooseOrchestrationPath(request.facts);
    const promptId = PROMPT_FOR[request.kind];

    const body =
      routing.path === 'claude_direct'
        ? await this.claudeDirect(request, promptId)
        : await this.gptThenClaude(request, promptId);

    // The ATS pass is not advisory. Its cleaned output is what ships, so filler
    // cannot survive a model ignoring the instruction not to produce it.
    const ats = checkAts(body, request.jobDescription);

    return {
      body: ats.cleaned,
      orchestrationPath: routing.path,
      routingReasons: routing.reasons,
      promptVersion: promptVersionTag(promptId),
      ats,
    };
  }

  /** Context is clear. One call. */
  private async claudeDirect(request: DraftRequest, promptId: PromptId): Promise<string> {
    const generator = await this.providers.textGenerator('ANTHROPIC');
    const result = await generator.generate({
      system: this.systemFor(promptId, request),
      cacheablePrefix: request.profileContext,
      maxTokens: MAX_TOKENS[request.kind],
      temperature: 0.3,
      messages: [{ role: 'user', content: this.brief(request) }],
    });
    return result.text.trim();
  }

  /**
   * Context is thin. GPT drafts, Claude refines against the real profile.
   *
   * The second call is not a style pass. Its job is to check the first draft
   * against what the Client actually said — a model working from thin context
   * fills gaps plausibly, and plausible-but-untrue is the specific failure mode
   * this step exists to catch.
   */
  private async gptThenClaude(request: DraftRequest, promptId: PromptId): Promise<string> {
    const gpt = await this.providers.textGenerator('OPENAI');
    const first = await gpt.generate({
      system: this.systemFor(promptId, request),
      cacheablePrefix: request.profileContext,
      maxTokens: MAX_TOKENS[request.kind],
      temperature: 0.4,
      messages: [{ role: 'user', content: this.brief(request) }],
    });

    const claude = await this.providers.textGenerator('ANTHROPIC');
    const refined = await claude.generate({
      system: this.systemFor(promptId, request),
      cacheablePrefix: request.profileContext,
      maxTokens: MAX_TOKENS[request.kind],
      temperature: 0.2,
      messages: [
        {
          role: 'user',
          content: [
            this.brief(request),
            '',
            'A first draft follows. Tighten it, check every claim against the',
            'candidate profile above, and remove anything the profile does not',
            'support. Return only the finished text.',
            '',
            '--- FIRST DRAFT ---',
            first.text.trim(),
            '--- END ---',
          ].join('\n'),
        },
      ],
    });

    return refined.text.trim();
  }

  private systemFor(promptId: PromptId, request: DraftRequest): string {
    // The seniority directive is appended to the shared prompt rather than
    // baked into it, because it differs per application while the prompt does
    // not — and keeping the prompt stable is what makes its version meaningful.
    return `${getPrompt(promptId).system}\n\nSENIORITY CALIBRATION FOR THIS APPLICATION\n${request.seniorityDirective}`;
  }

  private brief(request: DraftRequest): string {
    const parts = [
      `Role: ${request.jobTitle} at ${request.companyName}`,
      '',
      asUntrustedInput('job_description', request.jobDescription),
    ];
    if (request.questionText) {
      parts.push('', asUntrustedInput('screening_question', request.questionText));
    }
    return parts.join('\n');
  }
}
