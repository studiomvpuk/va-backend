import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../core/persistence/prisma.service';
import { stampedByTenant } from '../core/tenancy/tenant-stamped';
import type { TalkingPoint } from './prep-validation';
import type {
  IPrepRepository,
  PrepDocumentView,
  PrepQuestion,
} from './prep.repository';

const SELECT = Prisma.validator<Prisma.PrepDocumentSelect>()({
  id: true,
  applicationId: true,
  status: true,
  failureReason: true,
  companyBackground: true,
  likelyQuestions: true,
  talkingPoints: true,
  sources: true,
  generatedAt: true,
  createdAt: true,
  application: { select: { companyName: true, roleTitle: true } },
});

/** Derived from the select, so the row shape cannot drift from what is read. */
type Row = Prisma.PrepDocumentGetPayload<{ select: typeof SELECT }>;

function toView(row: Row): PrepDocumentView {
  return {
    id: row.id,
    applicationId: row.applicationId,
    status: row.status,
    failureReason: row.failureReason,
    companyBackground: row.companyBackground,
    // Json columns come back as unknown. Defaulting to [] rather than trusting
    // the shape keeps a hand-edited row from reaching the screen as a crash.
    likelyQuestions: asArray<PrepQuestion>(row.likelyQuestions),
    talkingPoints: asArray<TalkingPoint>(row.talkingPoints),
    sources: asArray<string>(row.sources),
    generatedAt: row.generatedAt,
    createdAt: row.createdAt,
    companyName: row.application.companyName,
    roleTitle: row.application.roleTitle,
  };
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

@Injectable()
export class PrismaPrepRepository implements IPrepRepository {
  constructor(private readonly prisma: PrismaService) {}

  async claim(applicationId: string): Promise<{ document: PrepDocumentView; created: boolean }> {
    const existing = await this.find(applicationId);
    if (existing) return { document: existing, created: false };

    try {
      const row = await this.prisma.client.prepDocument.create({
        data: stampedByTenant<Prisma.PrepDocumentUncheckedCreateInput>({
          applicationId,
          status: 'PENDING',
        }),
        select: SELECT,
      });
      return { document: toView(row), created: true };
    } catch (e) {
      // applicationId is unique. Two INTERVIEW clicks racing each other land
      // here, and the loser must not enqueue a second job.
      if ((e as { code?: string }).code === 'P2002') {
        const row = await this.find(applicationId);
        if (row) return { document: row, created: false };
      }
      throw e;
    }
  }

  async find(applicationId: string): Promise<PrepDocumentView | null> {
    const row = await this.prisma.client.prepDocument.findFirst({
      where: { applicationId },
      select: SELECT,
    });
    return row ? toView(row) : null;
  }

  async complete(
    applicationId: string,
    result: {
      companyBackground: string | null;
      likelyQuestions: PrepQuestion[];
      talkingPoints: TalkingPoint[];
      sources: string[];
    },
  ): Promise<PrepDocumentView> {
    await this.prisma.client.prepDocument.updateMany({
      where: { applicationId },
      data: {
        status: 'READY',
        failureReason: null,
        companyBackground: result.companyBackground,
        likelyQuestions: result.likelyQuestions,
        talkingPoints: result.talkingPoints,
        sources: result.sources,
        generatedAt: new Date(),
      },
    });

    const row = await this.find(applicationId);
    if (!row) throw new Error(`prep document for ${applicationId} vanished mid-write`);
    return row;
  }

  async fail(applicationId: string, reason: string): Promise<void> {
    await this.prisma.client.prepDocument.updateMany({
      where: { applicationId },
      // Truncated: this is shown to the Client, and a provider stack trace in
      // the UI is neither useful to them nor safe to display.
      data: { status: 'FAILED', failureReason: reason.slice(0, 300) },
    });
  }

  async evidenceFor(): Promise<{ profileFieldKeys: string[]; hasNarrative: boolean }> {
    const [fields, narrative] = await Promise.all([
      this.prisma.client.profileField.findMany({ select: { key: true } }),
      this.prisma.client.experienceNarrative.findFirst({ select: { id: true } }),
    ]);

    return {
      profileFieldKeys: (fields as { key: string }[]).map((f) => f.key),
      hasNarrative: narrative !== null,
    };
  }
}
