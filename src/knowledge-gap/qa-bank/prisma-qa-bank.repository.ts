import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../core/persistence/prisma.service';
import { isUniqueViolation } from '../../core/persistence/prisma-errors';
import { stampedByTenant } from '../../core/tenancy/tenant-stamped';
import { normaliseQuestion } from './qa-matcher';
import type {
  IQaBankRepository,
  QaBankRow,
  UpsertQaEntry,
} from './qa-bank.repository';

/**
 * Not a `clientId` in sight — the tenant extension puts it on every query
 * below. That is only true because nothing here uses $queryRaw, which is the
 * whole reason `embedding` is Float[] rather than pgvector (see schema.prisma).
 */
const SELECT = {
  id: true,
  questionText: true,
  answer: true,
  embedding: true,
  embeddingModel: true,
  confirmedAt: true,
} as const;

@Injectable()
export class PrismaQaBankRepository implements IQaBankRepository {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<QaBankRow[]> {
    const rows = await this.prisma.client.qaBankEntry.findMany({
      select: SELECT,
      orderBy: { confirmedAt: 'desc' },
    });
    return rows;
  }

  async upsert(entry: UpsertQaEntry, retriesLeft = 1): Promise<QaBankRow> {
    const questionKey = normaliseQuestion(entry.questionText);

    const existing = await this.prisma.client.qaBankEntry.findFirst({
      where: { questionKey },
      select: { id: true },
    });

    if (existing) {
      const row = await this.prisma.client.qaBankEntry.update({
        where: { id: existing.id },
        data: {
          // The question text is refreshed too: the Client just answered THIS
          // wording, so it is the better one to show them next time even though
          // the key is unchanged.
          questionText: entry.questionText,
          answer: entry.answer,
          embedding: entry.embedding,
          embeddingModel: entry.embeddingModel,
          confirmedAt: new Date(),
          ...(entry.sourceGapId ? { sourceGapId: entry.sourceGapId } : {}),
        },
        select: SELECT,
      });
      return row;
    }

    try {
      const row = await this.prisma.client.qaBankEntry.create({
        data: stampedByTenant<Prisma.QaBankEntryUncheckedCreateInput>({
          questionText: entry.questionText,
          questionKey,
          answer: entry.answer,
          embedding: entry.embedding,
          embeddingModel: entry.embeddingModel,
          ...(entry.sourceGapId ? { sourceGapId: entry.sourceGapId } : {}),
        }),
        select: SELECT,
      });
      return row;
    } catch (e) {
      // Two gaps for the same question resolved at once. The unique constraint
      // is what makes this a retry rather than a second, disagreeing entry —
      // the check above narrows the window, the constraint closes it.
      if (isUniqueViolation(e) && retriesLeft > 0) {
        return this.upsert(entry, retriesLeft - 1);
      }
      throw e;
    }
  }

  countForClient(): Promise<number> {
    return this.prisma.client.qaBankEntry.count();
  }
}

