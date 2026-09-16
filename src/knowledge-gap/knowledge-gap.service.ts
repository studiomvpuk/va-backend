import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { NotificationService } from '../notifications/notification.service';
import { PrismaService } from '../core/persistence/prisma.service';
import type { AppStatus } from '../applications/application.repository';
import {
  SETTINGS_REPOSITORY,
  type ISettingsRepository,
} from '../settings/settings.repository';
import { QaBankService } from './qa-bank/qa-bank.service';
import { GapDetector } from './gap-detector';
import { acceptTranscript, assertAcceptableAudio, type AudioMediaType } from './voice-answer';
import { ProviderFactory } from '../ai/provider-factory';
import { decideResume } from './resume-rule';
import { isGenuineGap, resolveGap } from './gap-resolution';
import {
  KNOWLEDGE_GAP_REPOSITORY,
  type IKnowledgeGapRepository,
  type KnowledgeGapView,
} from './knowledge-gap.repository';

/**
 * What the VA is told after asking a question on an application's behalf.
 *
 * `paused` carries no answer at all — not an empty one, not a hedged one. The
 * ASK_FIRST Client asked not to have anything guessed, and a best-effort answer
 * sitting in the VA's chat window is a guess the VA will reasonably paste in.
 */
export type QuestionOutcome =
  | { status: 'answered'; answer: string; source: 'qa_bank' | 'profile' }
  | { status: 'answered_with_assumption'; answer: string; assumption: string; gapId: string }
  | { status: 'paused'; vaMessage: string; gapId: string };

@Injectable()
export class KnowledgeGapService {
  private readonly logger = new Logger(KnowledgeGapService.name);

  constructor(
    @Inject(KNOWLEDGE_GAP_REPOSITORY)
    private readonly gaps: IKnowledgeGapRepository,
    @Inject(SETTINGS_REPOSITORY)
    private readonly settings: ISettingsRepository,
    private readonly qaBank: QaBankService,
    private readonly detector: GapDetector,
    private readonly notifications: NotificationService,
    private readonly prisma: PrismaService,
    private readonly providers: ProviderFactory,
  ) {}

  /**
   * The whole §5.3 flow for one screening question.
   *
   * Order is cost-ascending and it is not an optimisation: the Q&A bank is
   * checked first because a question the Client has already answered must never
   * be asked again, whatever a model would say about it this time.
   */
  async answerQuestion(input: {
    applicationId: string;
    vaId: string;
    questionText: string;
    profileContext: string;
    companyName: string;
    roleTitle: string;
  }): Promise<QuestionOutcome> {
    const previous = await this.qaBank.lookup(input.questionText);
    if (previous) {
      return { status: 'answered', answer: previous.entry.answer, source: 'qa_bank' };
    }

    const signal = await this.detector.detect(input);

    if (!isGenuineGap(signal)) {
      // The profile covered it; the model was hedging about wording. Nothing is
      // recorded and nobody is notified — a queue full of non-questions is a
      // queue the Client stops reading.
      return { status: 'answered', answer: signal.bestEffortAnswer, source: 'profile' };
    }

    // Read at the moment the gap occurs, never cached. This is what makes a
    // mode change take effect on the next question and not retroactively.
    const { gapMode } = await this.settings.get();

    const action = resolveGap({
      mode: gapMode,
      signal,
      questionText: input.questionText,
      companyName: input.companyName,
      roleTitle: input.roleTitle,
    });

    const gap = await this.gaps.create({
      applicationId: input.applicationId,
      vaId: input.vaId,
      questionText: input.questionText,
      // Null in ASK_FIRST: there is no guess to store, and storing one would
      // put it somewhere the Client could later mistake for their own answer.
      bestEffortAnswer: action.kind === 'proceed' ? action.answer : null,
    });

    if (action.kind === 'pause') {
      await this.blockApplication(input.applicationId);
    }

    await this.notifications.notify({
      kind: 'KNOWLEDGE_GAP',
      title: action.notify.title,
      body: action.notify.body,
      linkPath: `/dashboard#gap-${gap.id}`,
      urgent: action.notify.urgent,
    });

    return action.kind === 'pause'
      ? { status: 'paused', vaMessage: action.vaMessage, gapId: gap.id }
      : {
          status: 'answered_with_assumption',
          answer: action.answer,
          assumption: action.assumption,
          gapId: gap.id,
        };
  }

  /**
   * The Client answers (PRD §5.6).
   *
   * Three things happen, in this order, and each is meaningful:
   *   1. The gap is resolved and the answer recorded.
   *   2. The answer goes into the Q&A bank, so the question is never asked again.
   *   3. If nothing else is blocking it, the application resumes.
   *
   * The Q&A bank write is best-effort — if it fails, the Client has still
   * answered and the application still resumes; they will simply be asked again
   * one day. Letting an embedding failure roll back a resolved gap would be the
   * wrong trade by a wide margin.
   */
  async answerGap(id: string, clientAnswer: string): Promise<KnowledgeGapView> {
    const existing = await this.gaps.findById(id);
    if (!existing) throw new NotFoundException('Knowledge gap not found');

    const { gap, remainingForApplication } = await this.gaps.resolve(id, clientAnswer);

    try {
      await this.qaBank.record({
        questionText: gap.questionText,
        answer: clientAnswer,
        sourceGapId: gap.id,
      });
    } catch (e) {
      this.logger.warn(`answer recorded but not banked: ${describe(e)}`);
    }

    const decision = decideResume({
      applicationStatus: gap.applicationStatus,
      remainingUnresolvedGaps: remainingForApplication,
    });

    if (decision.resume) {
      await this.setApplicationStatus(gap.applicationId, decision.toStatus);
      return { ...gap, applicationStatus: decision.toStatus };
    }

    return gap;
  }

  /**
   * The same answer, spoken.
   *
   * Transcribe, then hand the text to `answerGap` — the one path that resolves
   * a gap, banks the answer and resumes the application. A second path that did
   * any of that itself would be a second place for the resume rule to drift.
   *
   * The Client's own answer, in their own words, is what gets stored: the
   * transcript is treated exactly as if they had typed it, including going into
   * the Q&A bank. Which is why `acceptTranscript` is strict — a transcriber's
   * guess at silence would be reused on every future application.
   */
  async answerGapByVoice(
    id: string,
    input: { audio: Buffer; mediaType: AudioMediaType },
  ): Promise<{ gap: KnowledgeGapView; transcript: string }> {
    assertAcceptableAudio({ bytes: input.audio.length, mediaType: input.mediaType });

    const transcriber = await this.providers.transcriber();
    const { text } = await transcriber.transcribe({
      audio: input.audio,
      mediaType: input.mediaType,
    });

    const transcript = acceptTranscript(text);
    const gap = await this.answerGap(id, transcript);

    // Returned so the UI can show what it heard. A Client who sees a mangled
    // transcript can correct it immediately, rather than finding out months
    // later from an application that used it.
    return { gap, transcript };
  }

  list(input: { unresolvedOnly: boolean; limit: number }): Promise<KnowledgeGapView[]> {
    return this.gaps.list(input);
  }

  countUnresolved(): Promise<number> {
    return this.gaps.countUnresolved();
  }

  // ───────────────────────────────────────────────────────────── internals

  private blockApplication(applicationId: string): Promise<unknown> {
    return this.setApplicationStatus(applicationId, 'BLOCKED');
  }

  /**
   * updateMany, so the tenant extension scopes it. A plain `update` by primary
   * key would let a VA's application id reach another Client's row if the
   * extension ever stopped covering unique wheres.
   */
  private setApplicationStatus(
    applicationId: string,
    status: AppStatus,
  ): Promise<unknown> {
    return this.prisma.client.application.updateMany({
      where: { id: applicationId },
      data: { status },
    });
  }
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
