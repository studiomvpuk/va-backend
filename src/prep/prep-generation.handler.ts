import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { JobRegistry } from '../core/jobs/job-registry';
import type { JobHandler, JobPayloadMap } from '../core/jobs/job-queue';
import { tenantContext } from '../core/tenancy/tenant.context';
import { NotificationService } from '../notifications/notification.service';
import { PrepComposer } from './prep-composer';
import { isWorthShowing } from './prep-validation';
import { PREP_REPOSITORY, type IPrepRepository } from './prep.repository';
import {
  APPLICATION_REPOSITORY,
  type IApplicationRepository,
} from '../applications/application.repository';
import { ProfileService } from '../profile/profile.service';

/**
 * The worker half. Everything slow lives here.
 *
 * ── It opens its own tenant context ─────────────────────────────────────────
 * A job runs long after the request that queued it, on a machine that may never
 * have served that request. There is no AsyncLocalStorage store to inherit, so
 * the first thing this does is open one from the payload — and every query
 * underneath is then scoped by the Prisma extension exactly as it would be in a
 * request. Without it, the first query throws MissingTenantContextError, which
 * is the correct failure but a confusing one to debug at a distance.
 */
@Injectable()
export class PrepGenerationHandler
  implements JobHandler<'prep-document.generate'>, OnModuleInit
{
  readonly name = 'prep-document.generate' as const;
  private readonly logger = new Logger(PrepGenerationHandler.name);

  constructor(
    private readonly registry: JobRegistry,
    private readonly composer: PrepComposer,
    private readonly notifications: NotificationService,
    @Inject(PREP_REPOSITORY) private readonly prep: IPrepRepository,
    @Inject(APPLICATION_REPOSITORY) private readonly applications: IApplicationRepository,
    private readonly profile: ProfileService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  handle(payload: JobPayloadMap['prep-document.generate']): Promise<void> {
    return tenantContext.run(
      {
        clientId: payload.clientId,
        // SYSTEM, not CLIENT: nobody is present. It also means an audit entry
        // written from here is honest about who acted.
        actorType: 'SYSTEM',
        actorId: 'prep-document-worker',
      },
      () => this.generate(payload.applicationId),
    );
  }

  private async generate(applicationId: string): Promise<void> {
    try {
      const application = await this.applications.find(applicationId);
      if (!application) {
        // Deleted between queueing and running. Nothing to write to, and
        // nothing to tell the Client about.
        this.logger.warn(`application ${applicationId} no longer exists`);
        return;
      }

      const [jobDescription, evidence, profileContext] = await Promise.all([
        this.applications.jobDescription(applicationId),
        this.prep.evidenceFor(),
        this.buildProfileContext(),
      ]);

      const prep = await this.composer.compose({
        companyName: application.companyName,
        roleTitle: application.roleTitle,
        jobDescription: jobDescription ?? '',
        profileContext,
        profileFieldKeys: evidence.profileFieldKeys,
        hasNarrative: evidence.hasNarrative,
      });

      if (!isWorthShowing(prep)) {
        // Everything the model produced failed its citations. An empty page
        // presented as a result is worse than saying so.
        await this.prep.fail(
          applicationId,
          'Nothing could be verified for this role. Try again, or add more to your profile first.',
        );
        await this.notify(application.companyName, application.roleTitle, applicationId, false);
        return;
      }

      await this.prep.complete(applicationId, {
        companyBackground: prep.background,
        likelyQuestions: prep.questions,
        talkingPoints: prep.talkingPoints,
        sources: prep.sources,
      });

      await this.notify(application.companyName, application.roleTitle, applicationId, true);
    } catch (e) {
      const reason = describe(e);
      this.logger.error(`prep generation failed for ${applicationId}: ${reason}`);

      // Recorded on the row, not just logged. A Client watching a spinner needs
      // the spinner to stop.
      await this.prep.fail(applicationId, reason).catch(() => undefined);
      // Rethrown so a Redis-backed queue retries. The FAILED row is overwritten
      // on a later success, so a retry that works leaves no trace of this.
      throw e;
    }
  }

  private async notify(
    companyName: string,
    roleTitle: string,
    applicationId: string,
    ready: boolean,
  ): Promise<void> {
    await this.notifications.notify({
      kind: 'SYSTEM',
      title: ready
        ? `Interview prep ready — ${roleTitle} at ${companyName}`
        : `Could not prepare notes — ${roleTitle} at ${companyName}`,
      body: ready
        ? `Your notes for ${companyName} are ready: what they are likely to ask, and what to make sure you say.`
        : `Nothing could be verified for this role, so no notes were written rather than guessing.`,
      linkPath: `/applications/${applicationId}/prep`,
      // Not urgent. An interview is scheduled; nothing is blocked on reading
      // this in the next five minutes, and email for it would be noise.
      urgent: false,
    });
  }

  /**
   * The same stable prefix the drafting path uses, so the provider cache hits.
   *
   * Built from ProfileService rather than the repository, deliberately: a
   * ProfileFieldView carries no sensitive value by construction, so there is no
   * filtering step here that a later edit could drop. The GENERAL check below
   * is belt and braces — even the LABELS of sensitive fields are a list of what
   * this Client considers private, and a prep document has no use for them.
   */
  private async buildProfileContext(): Promise<string> {
    const { fields, narrative } = await this.profile.getProfile();

    const general = fields
      .filter((f) => f.visibility === 'GENERAL' && f.value)
      .map((f) => `${f.label} (${f.key}): ${f.value}`)
      .join('\n');

    return [
      'CANDIDATE PROFILE',
      general || '(no general fields set)',
      '',
      'EXPERIENCE',
      narrative || '(no narrative set)',
    ].join('\n');
  }
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
