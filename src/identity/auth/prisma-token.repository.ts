import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../core/persistence/prisma.service';
import type {
  IRefreshTokenRepository,
  NewRefreshToken,
  StoredRefreshToken,
} from './token.repository';
import type { SubjectType } from './refresh-token.model';

/**
 * RefreshToken is not a tenant-scoped model (see the comment on it in
 * schema.prisma), so these queries need no tenant context and get none.
 */
@Injectable()
export class PrismaRefreshTokenRepository implements IRefreshTokenRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(token: NewRefreshToken): Promise<StoredRefreshToken> {
    return this.prisma.client.refreshToken.create({
      data: {
        tokenHash: token.tokenHash,
        familyId: token.familyId,
        subjectType: token.subjectType,
        subjectId: token.subjectId,
        expiresAt: token.expiresAt,
        ipAddress: token.ipAddress ?? null,
        userAgent: token.userAgent ?? null,
      },
      select: SELECT,
    });
  }

  async findByHash(tokenHash: string): Promise<StoredRefreshToken | null> {
    return this.prisma.client.refreshToken.findUnique({
      where: { tokenHash },
      select: SELECT,
    });
  }

  async markUsed(id: string): Promise<void> {
    await this.prisma.client.refreshToken.update({
      where: { id },
      data: { usedAt: new Date() },
    });
  }

  async revokeFamily(familyId: string): Promise<number> {
    const { count } = await this.prisma.client.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return count;
  }

  async revokeAllForSubject(
    subjectType: SubjectType,
    subjectId: string,
  ): Promise<number> {
    const { count } = await this.prisma.client.refreshToken.updateMany({
      where: { subjectType, subjectId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return count;
  }

  async deleteExpired(now: Date): Promise<number> {
    const { count } = await this.prisma.client.refreshToken.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    return count;
  }
}

const SELECT = {
  id: true,
  tokenHash: true,
  familyId: true,
  subjectType: true,
  subjectId: true,
  expiresAt: true,
  usedAt: true,
  revokedAt: true,
} as const;
