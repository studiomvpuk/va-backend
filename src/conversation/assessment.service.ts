import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { FitScoringService } from '../assessment/fit/fit-scoring.service';
import { ApplicationPolicyService } from '../assessment/fit/application-policy.service';
import { DraftingService, type DraftKind } from '../drafting/drafting.service';
import { DisclosureService } from '../disclosure/disclosure.service';
import { RateLimitService } from '../ratelimit/rate-limit.service';
import {
  APPLICATION_REPOSITORY,
  type ApplicationView,
  type DraftView,
  type IApplicationRepository,
} from '../applications/application.repository';
import { PROFILE_REPOSITORY, type IProfileRepository } from '../profile/profile.repository';
import {
  TARGET_ROLE_REPOSITORY,
  type ITargetRoleRepository,
} from '../targeting/target-role.repository';
import {
  SETTINGS_REPOSITORY,
  type ISettingsRepository,
} from '../settings/settings.repository';
import { analysePosting } from '../assessment/seniority/seniority';
import type { ContextFacts } from '../drafting/orchestration-rule';
import type { PolicyDecision } from '../assessment/fit/application-policy.service';

export interface AssessedPosting {
  application: ApplicationView;
  decision: PolicyDecision;
}

/**
 * The VA's loop, end to end: paste a posting, get a verdict; ask for a draft,
 * get one finished answer.
 *
 * This is the composition layer. It holds no rules of its own — scoring,
 * policy, orchestration and disclosure each own theirs, and this decides the
 * order they run in. That is deliberate: every rule worth arguing about is
 * testable without this class, and this class is testable without any of them.
 */
@Injectable()
export class AssessmentService {
  constructor(
    private readonly fit: FitScoringService,
    private readonly policy: ApplicationPolicyService,
    private readonly drafting: DraftingService,
    private readonly disclosure: DisclosureService,
    private readonly limits: RateLimitService,
    @Inject(APPLICATION_REPOSITORY) private readonly applications: IApplicationRepository,
    @Inject(PROFILE_REPOSITORY) private readonly profile: IProfileRepository,
    @Inject(TARGET_ROLE_REPOSITORY) private readonly roles: ITargetRoleRepository,
    @Inject(SETTINGS_REPOSITORY) private readonly settings: ISettingsRepository,
  ) {}

  /** Paste a job description, get a score and a verdict. */
  async assess(input: {
    clientId: string;
    vaId: string;
    companyName: string;
    roleTitle: string;
    jobDescription: string;
    siteId?: string;
  }): Promise<AssessedPosting> {
    await this.limits.consumeClientAiCall(input.clientId);

    const [narrative, targetRoles, settings] = await Promise.all([
      this.profile.getNarrative(),
      this.roles.list(),
      this.settings.get(),
    ]);

    const assessment = await this.fit.score({
      title: input.roleTitle,
      companyName: input.companyName,
      jobDescription: input.jobDescription,
      targetRoles,
      profileNarrative: narrative?.body ?? '',
      candidateYears: estimateYears(narrative?.body ?? ''),
    });

    const decision = this.policy.decide(assessment.score, settings.minFitScore);

    const application = await this.applications.create({
      vaId: input.vaId,
      siteId: input.siteId ?? null,
      companyName: input.companyName,
      roleTitle: input.roleTitle,
      jobDescription: input.jobDescription,
      fitScore: assessment.score,
      fitReasoning: assessment.reasoning,
      seniorityVerdict: assessment.seniority.verdict,
      // A skip is recorded, not discarded — the Client should be able to see
      // what was passed over and loosen the threshold if too much was.
      status: decision.verdict === 'SKIP' ? 'SKIPPED' : 'IN_PROGRESS',
    });

    return { application, decision };
  }

  /** Request a draft for an application the VA is working on. */
  async draft(input: {
    clientId: string;
    applicationId: string;
    kind: DraftKind;
    questionText?: string;
  }): Promise<DraftView> {
    const application = await this.applications.find(input.applicationId);
    if (!application) throw new NotFoundException('Application not found');

    const jobDescription = await this.applications.jobDescription(input.applicationId);
    if (jobDescription === null) throw new NotFoundException('Application not found');

    // GPT-then-Claude costs two provider calls, so the allowance is charged for
    // what the routing decision actually implies.
    const [narrative, fields] = await Promise.all([
      this.profile.getNarrative(),
      this.profile.listFields(),
    ]);

    const facts: ContextFacts = {
      profileNarrativeLength: narrative?.body.length ?? 0,
      populatedFieldCount: fields.filter((f) => f.hasValue).length,
      qaBankHit: false,
      isKnownGap: false,
      fitConfidence: analysePosting({
        title: application.roleTitle,
        description: jobDescription,
      }).confidence,
      jobDescriptionLength: jobDescription.length,
    };

    await this.limits.consumeClientAiCall(input.clientId, facts.isKnownGap ? 2 : 1);

    const result = await this.drafting.draft({
      kind: input.kind,
      questionText: input.questionText,
      jobTitle: application.roleTitle,
      companyName: application.companyName,
      jobDescription,
      profileContext: this.profileContext(narrative?.body ?? '', fields),
      seniorityDirective: directiveFor(application.seniorityVerdict),
      facts,
    });

    return this.applications.addDraft({
      applicationId: input.applicationId,
      kind: input.kind,
      questionText: input.questionText ?? null,
      body: result.body,
      orchestrationPath: result.orchestrationPath,
      promptVersion: result.promptVersion,
      atsChecked: result.ats.passes,
    });
  }

  /** Does this screening question need a protected field? */
  async resolveDisclosure(input: {
    questionText: string;
    vaId: string;
    applicationId?: string;
  }) {
    const fields = await this.profile.listFields();
    return this.disclosure.resolve({
      questionText: input.questionText,
      // Labels and keys only — the values are not in this object and cannot be.
      candidates: fields
        .filter((f) => f.visibility === 'SENSITIVE' && f.hasValue)
        .map((f) => ({ id: f.id, key: f.key, label: f.label })),
      actor: { actorType: 'VA', actorId: input.vaId },
      applicationId: input.applicationId,
    });
  }

  /** The stable prefix: identical for every application this Client makes. */
  private profileContext(
    narrative: string,
    fields: { label: string; value: string | null; visibility: string }[],
  ): string {
    const general = fields
      .filter((f) => f.visibility === 'GENERAL' && f.value)
      .map((f) => `- ${f.label}: ${f.value}`)
      .join('\n');

    return [
      'CANDIDATE PROFILE',
      narrative || '(no written experience on file)',
      '',
      'DETAILS',
      general || '(no structured fields set)',
    ].join('\n');
  }
}

function directiveFor(verdict: ApplicationView['seniorityVerdict']): string {
  switch (verdict) {
    case 'OVER_LEVELLED':
      return 'De-emphasise leadership scope, strategic remit and total years. Reframe the same real work at the level this role asks for. Change emphasis, not truth.';
    case 'UNDER_LEVELLED':
      return 'Foreground the most senior-sounding relevant achievements they genuinely have. Close the gap rather than underselling. Do not claim experience they do not have.';
    default:
      return 'Present their experience straight — no reframing up or down.';
  }
}

/**
 * A rough years-of-experience read from the narrative.
 *
 * Deliberately crude, and only a default: the seniority calibration is what
 * actually matters and the Client can correct it by writing their years into
 * the profile. Guessing badly here shifts a draft's emphasis; it does not
 * invent anything.
 */
export function estimateYears(narrative: string): number {
  const explicit = /\b(\d{1,2})\+?\s*years?(?:\s+of)?\s+(?:commercial\s+|professional\s+)?experience\b/i.exec(
    narrative,
  );
  if (explicit) return Number(explicit[1]);

  const years = [...narrative.matchAll(/\b(19|20)\d{2}\b/g)].map((m) => Number(m[0]));
  if (years.length >= 2) {
    const span = Math.max(...years) - Math.min(...years);
    if (span > 0 && span < 50) return span;
  }
  return 3;
}
