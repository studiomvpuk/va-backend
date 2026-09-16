import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { stampedByTenant } from '../core/tenancy/tenant-stamped';
import { PrismaService } from '../core/persistence/prisma.service';
import type {
  AppStatus,
  ApplicationStats,
  ApplicationView,
  DraftView,
  IApplicationRepository,
  SeniorityVerdict,
} from './application.repository';

const SELECT = {
  id: true,
  companyName: true,
  roleTitle: true,
  fitScore: true,
  fitReasoning: true,
  seniorityVerdict: true,
  status: true,
  createdAt: true,
  appliedAt: true,
} as const;

interface Row {
  id: string;
  companyName: string;
  roleTitle: string;
  fitScore: { toString(): string } | null;
  fitReasoning: string | null;
  seniorityVerdict: string | null;
  status: string;
  createdAt: Date;
  appliedAt: Date | null;
}

function toView(row: Row): ApplicationView {
  return {
    id: row.id,
    companyName: row.companyName,
    roleTitle: row.roleTitle,
    // Decimal(3,1) arrives as a Prisma Decimal, not a number.
    fitScore: row.fitScore === null ? null : Number(row.fitScore.toString()),
    fitReasoning: row.fitReasoning,
    seniorityVerdict: row.seniorityVerdict as SeniorityVerdict | null,
    status: row.status as AppStatus,
    createdAt: row.createdAt,
    appliedAt: row.appliedAt,
  };
}

type StatusCount = { status: string; _count: { _all: number } };

/**
 * Prisma returns an average over a Decimal column as a Decimal, not a number,
 * and `String()` on one is the Object default — "[object Object]" — which then
 * becomes NaN. Going through its own toString is the only reliable path, and
 * null (nothing scored yet) becomes 0 so the dashboard's count-up has a number.
 */
function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  const parsed = Number((value as { toString(): string }).toString());
  return Number.isFinite(parsed) ? parsed : 0;
}

@Injectable()
export class PrismaApplicationRepository implements IApplicationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async list(filter: { status?: AppStatus; limit?: number } = {}) {
    const rows = await this.prisma.client.application.findMany({
      where: filter.status ? { status: filter.status } : {},
      select: SELECT,
      orderBy: { createdAt: 'desc' },
      take: filter.limit ?? 50,
    });
    return (rows as Row[]).map(toView);
  }

  /**
   * Two queries, both scoped by the extension and both served by the
   * `[clientId, status]` index — a groupBy over the status column, and one
   * average over the scored rows. No row bodies cross the wire.
   */
  async stats(): Promise<ApplicationStats> {
    const [byStatus, fit] = await Promise.all([
      this.prisma.client.application.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      this.prisma.client.application.aggregate({
        where: { fitScore: { not: null } },
        _avg: { fitScore: true },
      }),
    ]);

    const counts = new Map<string, number>(
      (byStatus as StatusCount[]).map((g) => [g.status, g._count._all]),
    );
    const sum = (...statuses: AppStatus[]) =>
      statuses.reduce((n, status) => n + (counts.get(status) ?? 0), 0);

    const average = (fit as { _avg: { fitScore: unknown } })._avg.fitScore;

    return {
      applications: sum('APPLIED', 'INTERVIEW', 'REJECTED', 'OFFER'),
      // An offer came from an interview, so it counts as one.
      interviews: sum('INTERVIEW', 'OFFER'),
      waitingOnYou: sum('BLOCKED'),
      // Null when nothing is scored yet. Zero rather than null, so the count-up
      // on the dashboard has a number to animate to on first load.
      averageFit: toNumber(average),
    };
  }

  async find(id: string) {
    const row = await this.prisma.client.application.findUnique({
      where: { id },
      select: SELECT,
    });
    return row ? toView(row) : null;
  }

  async create(input: {
    vaId: string | null;
    siteId: string | null;
    companyName: string;
    roleTitle: string;
    jobDescription: string;
    fitScore: number;
    fitReasoning: string;
    seniorityVerdict: SeniorityVerdict;
    status: AppStatus;
  }) {
    const row = await this.prisma.client.application.create({
      data: stampedByTenant<Prisma.ApplicationUncheckedCreateInput>(input),
      select: SELECT,
    });
    return toView(row);
  }

  async updateStatus(id: string, status: AppStatus) {
    const row = await this.prisma.client.application.update({
      where: { id },
      data: {
        status,
        // Stamped once, when it actually happens.
        ...(status === 'APPLIED' ? { appliedAt: new Date() } : {}),
      },
      select: SELECT,
    });
    return toView(row);
  }

  async jobDescription(id: string) {
    const row = (await this.prisma.client.application.findUnique({
      where: { id },
      select: { jobDescription: true },
    }));
    return row?.jobDescription ?? null;
  }

  async addDraft(input: {
    applicationId: string;
    kind: 'CV' | 'COVER_LETTER' | 'SCREENING_ANSWER';
    questionText: string | null;
    body: string;
    orchestrationPath: string;
    promptVersion: string;
    atsChecked: boolean;
  }) {
    return this.prisma.client.draft.create({
      data: stampedByTenant<Prisma.DraftUncheckedCreateInput>(input),
      select: {
        id: true,
        kind: true,
        questionText: true,
        body: true,
        orchestrationPath: true,
        promptVersion: true,
        createdAt: true,
      },
    }) as Promise<DraftView>;
  }

  async drafts(applicationId: string) {
    return this.prisma.client.draft.findMany({
      where: { applicationId },
      select: {
        id: true,
        kind: true,
        questionText: true,
        body: true,
        orchestrationPath: true,
        promptVersion: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    }) as Promise<DraftView[]>;
  }

  async countThisWeek() {
    const since = new Date(Date.now() - 7 * 86_400_000);
    return this.prisma.client.application.count({
      where: { createdAt: { gte: since }, status: { not: 'SKIPPED' } },
    });
  }

}
