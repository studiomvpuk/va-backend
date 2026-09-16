import { Inject, Injectable, Logger } from '@nestjs/common';
import { ProviderFactory } from '../ai/provider-factory';
import { asUntrustedInput, getPrompt } from '../ai/prompts/prompt-registry';
import {
  SENSITIVE_VALUE_READER,
  type ISensitiveValueReader,
} from './sensitive-value.repository';

export interface SensitiveFieldRef {
  id: string;
  key: string;
  label: string;
}

export interface DisclosureRequest {
  questionText: string;
  /** Labels and keys ONLY. Values never enter this call. */
  candidates: SensitiveFieldRef[];
  actor: { actorType: 'CLIENT' | 'VA'; actorId: string };
  applicationId?: string;
}

export type DisclosureOutcome =
  | { disclosed: true; field: SensitiveFieldRef; value: string; reason: string }
  | { disclosed: false; reason: string };

/**
 * Decides whether a screening question genuinely requires one protected field,
 * and if so releases exactly that one.
 *
 * ── The security property ───────────────────────────────────────────────────
 * The model PROPOSES; this code DECIDES.
 *
 * PRD §7.2 names the threat directly: a job description is attacker-
 * controllable text being fed to a model that sits next to a sensitivity gate.
 * If the model's output were the authorisation, then text inside a posting
 * could talk it into releasing an address.
 *
 * Three things make that not work here:
 *
 *   1. The model never sees a value. It is given labels and keys, and asked
 *      which key — if any — the question requires. There is nothing in its
 *      context to exfiltrate.
 *   2. Its answer is validated against the candidate set before anything is
 *      read. A key it invented, or one belonging to a field that was not
 *      offered, releases nothing.
 *   3. The read itself goes through the one audited path, which logs inside the
 *      same transaction.
 *
 * The worst a successful injection achieves is causing ONE already-eligible
 * field to be disclosed to the VA who asked, and logged.
 */
@Injectable()
export class DisclosureService {
  private readonly logger = new Logger(DisclosureService.name);

  constructor(
    private readonly providers: ProviderFactory,
    @Inject(SENSITIVE_VALUE_READER) private readonly reader: ISensitiveValueReader,
  ) {}

  async resolve(request: DisclosureRequest): Promise<DisclosureOutcome> {
    if (request.candidates.length === 0) {
      return { disclosed: false, reason: 'no protected fields are configured' };
    }

    const proposal = await this.propose(request);
    if (!proposal) {
      return { disclosed: false, reason: 'the question does not require a protected field' };
    }

    // ── The decision, in code ────────────────────────────────────────────
    // A key the model invented, or one for a field that was not offered,
    // releases nothing. This is the line the model cannot talk its way past.
    const field = request.candidates.find((c) => c.key === proposal.fieldKey);
    if (!field) {
      this.logger.warn(
        `Classifier proposed field key "${proposal.fieldKey}", which was not in ` +
          `the candidate set. Refusing.`,
      );
      return { disclosed: false, reason: 'the proposed field was not offered' };
    }

    const value = await this.reader.reveal({
      profileFieldId: field.id,
      reason: `a screening question required "${field.label}"`,
      disclosedTo: request.actor,
      questionText: request.questionText,
      applicationId: request.applicationId,
    });

    if (value === null) {
      return { disclosed: false, reason: 'that field has no value stored' };
    }

    return { disclosed: true, field, value, reason: proposal.reason };
  }

  /** Asks the model. Labels only, never values. */
  private async propose(
    request: DisclosureRequest,
  ): Promise<{ fieldKey: string; reason: string } | null> {
    const prompt = getPrompt('disclosure.classify');
    const generator = await this.providers.textGenerator();

    const result = await generator.generate({
      system: prompt.system,
      maxTokens: 512,
      // Zero: the same question against the same fields must not sometimes
      // release and sometimes not.
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            asUntrustedInput('screening_question', request.questionText),
            '',
            'Available protected fields (labels only):',
            ...request.candidates.map((c) => `- ${c.key}: ${c.label}`),
          ].join('\n'),
        },
      ],
    });

    return parseProposal(result.text);
  }
}

/**
 * Reads the classifier's answer.
 *
 * Unparseable output means no disclosure. Failing closed is the only safe
 * direction here: the cost of a wrong "no" is the VA asking the Client, and the
 * cost of a wrong "yes" is releasing protected data.
 */
export function parseProposal(raw: string): { fieldKey: string; reason: string } | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const candidates = [fenced?.[1], raw].filter(Boolean) as string[];

  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) continue;
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1)) as {
        fieldKey?: unknown;
        reason?: unknown;
      };
      if (typeof parsed.fieldKey !== 'string' || !parsed.fieldKey) return null;
      return {
        fieldKey: parsed.fieldKey,
        reason: typeof parsed.reason === 'string' ? parsed.reason : 'required by the question',
      };
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}
