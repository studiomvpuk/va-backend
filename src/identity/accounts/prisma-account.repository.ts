import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../core/persistence/prisma.service';
import { isUniqueViolation } from '../../core/persistence/prisma-errors';
import { runUnscoped } from '../../core/tenancy/tenant.context';
import {
  EmailAlreadyRegisteredError,
  type ClientRecord,
  type IAccountRepository,
  type VaRecord,
} from './client.repository';

/**
 * The only repository that reads outside tenant scope, and it does so because
 * authentication has no tenant yet — the account being looked up is what
 * determines the tenant.
 *
 * Client and VirtualAssistant are the two models this touches. Client is not
 * tenant-scoped at all (it IS the tenant root). VirtualAssistant is, so those
 * two reads are wrapped in runUnscoped() and each is named here rather than
 * anywhere else in the codebase.
 */
@Injectable()
export class PrismaAccountRepository implements IAccountRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findClientByEmail(email: string): Promise<ClientRecord | null> {
    return this.prisma.client.client.findUnique({
      where: { email },
      select: SELECT_CLIENT,
    });
  }

  async findClientById(id: string): Promise<ClientRecord | null> {
    return this.prisma.client.client.findUnique({
      where: { id },
      select: SELECT_CLIENT,
    });
  }

  async createClient(input: {
    email: string;
    fullName: string;
    passwordHash: string;
  }): Promise<ClientRecord> {
    try {
      return await this.prisma.client.client.create({
        data: {
          email: input.email,
          fullName: input.fullName,
          passwordHash: input.passwordHash,
          // Every Client starts with the documented defaults rather than null
          // settings, so nothing downstream has to handle "not configured yet".
          settings: { create: {} },
        },
        select: SELECT_CLIENT,
      });
    } catch (e) {
      // Losing the race against a concurrent signup for the same email is a
      // conflict, not a 500. The unique index is the real guarantee; the
      // pre-check in AuthService is only for a friendlier common path.
      if (isUniqueViolation(e)) throw new EmailAlreadyRegisteredError();
      throw e;
    }
  }

  async updateClientPasswordHash(id: string, passwordHash: string): Promise<void> {
    await this.prisma.client.client.update({ where: { id }, data: { passwordHash } });
  }

  async findVaById(id: string): Promise<VaRecord | null> {
    // VirtualAssistant is tenant-scoped, and at this point there is no tenant —
    // resolving the VA is how we learn which one. Named explicitly.
    return runUnscoped(() =>
      this.prisma.client.virtualAssistant.findUnique({
        where: { id },
        select: SELECT_VA,
      }),
    );
  }

  async findVaByEmail(email: string): Promise<VaRecord | null> {
    // Email is unique per Client, not globally — two Clients may each invite the
    // same person. findFirst is correct: a VA signing in with one set of
    // credentials resolves to one account, and a second invitation of the same
    // person is a separate account with its own password.
    return runUnscoped(() =>
      this.prisma.client.virtualAssistant.findFirst({
        where: { email, revokedAt: null },
        select: SELECT_VA,
        orderBy: { createdAt: 'asc' },
      }),
    );
  }
}

const SELECT_CLIENT = {
  id: true,
  email: true,
  fullName: true,
  passwordHash: true,
} as const;

const SELECT_VA = {
  id: true,
  clientId: true,
  email: true,
  fullName: true,
  passwordHash: true,
  revokedAt: true,
} as const;

