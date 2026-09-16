import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { stampedByTenant } from '../../core/tenancy/tenant-stamped';
import { PrismaService } from '../../core/persistence/prisma.service';
import { currentTenant, runUnscoped } from '../../core/tenancy/tenant.context';
import type { IVaRepository, VaAccessState, VaSummary } from './va.repository';

const SUMMARY = {
  id: true,
  email: true,
  fullName: true,
  createdAt: true,
  revokedAt: true,
  passwordHash: true,
  inviteToken: true,
  inviteExpiry: true,
  agreement: {
    select: {
      signedAt: true,
      signedName: true,
      documentVersion: true,
      documentHash: true,
    },
  },
} as const;

interface SummaryRow {
  id: string;
  email: string;
  fullName: string;
  createdAt: Date;
  revokedAt: Date | null;
  passwordHash: string | null;
  inviteToken: string | null;
  inviteExpiry: Date | null;
  agreement: {
    signedAt: Date;
    signedName: string;
    documentVersion: string;
    documentHash: string;
  } | null;
}

function toSummary(row: SummaryRow): VaSummary {
  return {
    id: row.id,
    email: row.email,
    fullName: row.fullName,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt,
    invitePending:
      row.passwordHash === null &&
      row.inviteToken !== null &&
      (row.inviteExpiry?.getTime() ?? 0) > Date.now(),
    agreement: row.agreement,
    // Note what never leaves this function: passwordHash and inviteToken.
  };
}

@Injectable()
export class PrismaVaRepository implements IVaRepository {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<VaSummary[]> {
    const rows = await this.prisma.client.virtualAssistant.findMany({
      select: SUMMARY,
      orderBy: { createdAt: 'asc' },
    });
    return (rows as SummaryRow[]).map(toSummary);
  }

  async find(id: string): Promise<VaSummary | null> {
    const row = await this.prisma.client.virtualAssistant.findUnique({
      where: { id },
      select: SUMMARY,
    });
    return row ? toSummary(row) : null;
  }

  async findByEmail(email: string): Promise<VaSummary | null> {
    const row = await this.prisma.client.virtualAssistant.findFirst({
      where: { email },
      select: SUMMARY,
    });
    return row ? toSummary(row) : null;
  }

  async invite(input: {
    email: string;
    fullName: string;
    inviteTokenHash: string;
    inviteExpiry: Date;
  }): Promise<VaSummary> {
    const row = await this.prisma.client.virtualAssistant.create({
      data: stampedByTenant<Prisma.VirtualAssistantUncheckedCreateInput>({
        email: input.email,
        fullName: input.fullName,
        inviteToken: input.inviteTokenHash,
        inviteExpiry: input.inviteExpiry,
      }),
      select: SUMMARY,
    });
    return toSummary(row);
  }

  async refreshInvite(
    id: string,
    inviteTokenHash: string,
    inviteExpiry: Date,
  ): Promise<VaSummary> {
    const row = await this.prisma.client.virtualAssistant.update({
      where: { id },
      data: { inviteToken: inviteTokenHash, inviteExpiry, revokedAt: null },
      select: SUMMARY,
    });
    return toSummary(row);
  }

  async acceptInvite(
    inviteTokenHash: string,
    passwordHash: string,
    now: Date,
  ): Promise<{ id: string; clientId: string; email: string; fullName: string } | null> {
    // Accepting happens BEFORE the VA has a session, so there is no tenant —
    // the token is what identifies which Client they belong to. Same
    // bootstrapping problem as login, handled the same named way.
    return runUnscoped(async () => {
      const va = await this.prisma.client.virtualAssistant.findFirst({
        where: {
          inviteToken: inviteTokenHash,
          inviteExpiry: { gt: now },
          passwordHash: null,
          revokedAt: null,
        },
        select: { id: true, clientId: true, email: true, fullName: true },
      });
      if (!va) return null;

      // Burning the token in the same statement as setting the password is what
      // makes the invite single-use: a second request finds no matching row.
      const { count } = await this.prisma.client.virtualAssistant.updateMany({
        where: { id: va.id, inviteToken: inviteTokenHash, passwordHash: null },
        data: { passwordHash, inviteToken: null, inviteExpiry: null },
      });
      // Lost a race against a concurrent acceptance of the same link.
      return count === 1 ? va : null;
    }, 'VA invite acceptance — no tenant until the token resolves one');
  }

  async revoke(id: string): Promise<void> {
    await this.prisma.client.virtualAssistant.update({
      where: { id },
      data: { revokedAt: new Date(), inviteToken: null, inviteExpiry: null },
    });
  }

  async restore(id: string): Promise<void> {
    await this.prisma.client.virtualAssistant.update({
      where: { id },
      data: { revokedAt: null },
    });
  }

  async signAgreement(input: {
    vaId: string;
    documentVersion: string;
    documentHash: string;
    signedName: string;
    ipAddress: string;
    userAgent: string;
  }): Promise<void> {
    const clientId = currentTenant()?.clientId;
    if (!clientId) throw new Error('No tenant context for an agreement signature');

    await this.prisma.client.agreement.upsert({
      where: { vaId: input.vaId },
      create: {
        clientId,
        vaId: input.vaId,
        documentVersion: input.documentVersion,
        documentHash: input.documentHash,
        signedName: input.signedName,
        signedAt: new Date(),
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      },
      // Re-signing (a new agreement version) replaces the record; the previous
      // signature's own version and hash are preserved in the audit log.
      update: {
        documentVersion: input.documentVersion,
        documentHash: input.documentHash,
        signedName: input.signedName,
        signedAt: new Date(),
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      },
    });
  }

  async accessState(vaId: string): Promise<VaAccessState | null> {
    const row = (await this.prisma.client.virtualAssistant.findUnique({
      where: { id: vaId },
      select: { id: true, revokedAt: true, agreement: { select: { id: true } } },
    }));

    if (!row) return null;
    return {
      id: row.id,
      revokedAt: row.revokedAt,
      hasSignedAgreement: row.agreement !== null,
    };
  }
}
