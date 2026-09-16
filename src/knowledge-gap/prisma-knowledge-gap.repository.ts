import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../core/persistence/prisma.service';
import { stampedByTenant } from '../core/tenancy/tenant-stamped';
import type {
  CreateGapInput,
  IKnowledgeGapRepository,
  KnowledgeGapView,
} from './knowledge-gap.repository';

const SELECT = Prisma.validator<Prisma.KnowledgeGapSelect>()({
  id: true,
  applicationId: true,
  vaId: true,
  questionText: true,
  bestEffortAnswer: true,
  clientAnswer: true,
  resolvedAt: true,
  createdAt: true,
  application: { select: { companyName: true, roleTitle: true, status: true } },
});

/** Derived from the select, so the row shape cannot drift from what is read. */
type Row = Prisma.KnowledgeGapGetPayload<{ select: typeof SELECT }>;

function toView(row: Row): KnowledgeGapView {
  return {
    id: row.id,
    applicationId: row.applicationId,
    vaId: row.vaId,
    questionText: row.questionText,
    bestEffortAnswer: row.bestEffortAnswer,
    clientAnswer: row.clientAnswer,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
    companyName: row.application.companyName,
    roleTitle: row.application.roleTitle,
    applicationStatus: row.application.status,
  };
}

@Injectable()
export class PrismaKnowledgeGapRepository implements IKnowledgeGapRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateGapInput): Promise<KnowledgeGapView> {
    const row = await this.prisma.client.knowledgeGap.create({
      data: stampedByTenant<Prisma.KnowledgeGapUncheckedCreateInput>({
        applicationId: input.applicationId,
        vaId: input.vaId,
        questionText: input.questionText,
        bestEffortAnswer: input.bestEffortAnswer,
      }),
      select: SELECT,
    });
    return toView(row);
  }

  async findById(id: string): Promise<KnowledgeGapView | null> {
    const row = await this.prisma.client.knowledgeGap.findFirst({
      where: { id },
      select: SELECT,
    });
    return row ? toView(row) : null;
  }

  async list(input: { unresolvedOnly: boolean; limit: number }): Promise<KnowledgeGapView[]> {
    const rows = await this.prisma.client.knowledgeGap.findMany({
      where: input.unresolvedOnly ? { resolvedAt: null } : {},
      // Oldest first: this is a queue of people waiting, not a news feed.
      orderBy: { createdAt: 'asc' },
      take: input.limit,
      select: SELECT,
    });
    return rows.map(toView);
  }

  countUnresolved(): Promise<number> {
    return this.prisma.client.knowledgeGap.count({ where: { resolvedAt: null } });
  }

  countUnresolvedForApplication(applicationId: string): Promise<number> {
    return this.prisma.client.knowledgeGap.count({
      where: { applicationId, resolvedAt: null },
    });
  }

  async resolve(
    id: string,
    clientAnswer: string,
  ): Promise<{ gap: KnowledgeGapView; remainingForApplication: number }> {
    // `tx` is deliberately un-annotated: it is not the extended client, and
    // naming it as one made TypeScript select the array form of $transaction
    // and infer the whole result as any[].
    return this.prisma.client.$transaction(async (tx) => {
      await tx.knowledgeGap.updateMany({
        where: { id, resolvedAt: null },
        data: { clientAnswer, resolvedAt: new Date() },
      });

      const row = await tx.knowledgeGap.findFirst({ where: { id }, select: SELECT });
      if (!row) throw new Error(`knowledge gap ${id} not found`);

      const gap = toView(row);
      const remainingForApplication = await tx.knowledgeGap.count({
        where: { applicationId: gap.applicationId, resolvedAt: null },
      });

      return { gap, remainingForApplication };
    });
  }
}
