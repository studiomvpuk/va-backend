import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../core/persistence/prisma.service';
import { toBytes } from '../core/persistence/bytes';
import { currentTenant } from '../core/tenancy/tenant.context';
import { stampedByTenant } from '../core/tenancy/tenant-stamped';
import type {
  IProfileRepository,
  ProfileFieldView,
} from './profile.repository';
import type { CipherEnvelope } from '../core/crypto/cipher.interface';

/**
 * Every query here is tenant-scoped automatically by the Prisma extension —
 * there is not a single `clientId` in a where clause below, and that is the
 * point (PRD §2.5).
 *
 * The select list is the security boundary: `sensitive: { select: { id: true } }`
 * tells us a value exists without loading the ciphertext. No method in this file
 * selects `ciphertext`, and an architecture test enforces that.
 */
const SELECT = Prisma.validator<Prisma.ProfileFieldSelect>()({
  id: true,
  key: true,
  label: true,
  visibility: true,
  value: true,
  updatedAt: true,
  sensitive: { select: { id: true } },
});

/**
 * Derived from the select above rather than hand-written.
 *
 * It used to be a hand-maintained interface with a cast at every call site, and
 * the cast was hiding a real discrepancy: the hand-written type claimed a
 * `sensitive` property that the payload type did not actually carry. Deriving
 * it means the shape cannot drift from what is selected, and the casts go away.
 */
type Row = Prisma.ProfileFieldGetPayload<{ select: typeof SELECT }>;

function toView(row: Row): ProfileFieldView {
  const sensitive = row.visibility === 'SENSITIVE';
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    visibility: sensitive ? 'SENSITIVE' : 'GENERAL',
    // Belt and braces: even if a sensitive row somehow carried a plaintext
    // value, it does not leave this function.
    value: sensitive ? null : row.value,
    hasValue: sensitive ? row.sensitive !== null : row.value !== null,
    updatedAt: row.updatedAt,
  };
}

@Injectable()
export class PrismaProfileRepository implements IProfileRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listFields(): Promise<ProfileFieldView[]> {
    const rows = await this.prisma.client.profileField.findMany({
      select: SELECT,
      orderBy: { key: 'asc' },
    });
    return rows.map(toView);
  }

  async findField(id: string): Promise<ProfileFieldView | null> {
    const row = await this.prisma.client.profileField.findUnique({
      where: { id },
      select: SELECT,
    });
    return row ? toView(row) : null;
  }

  async findFieldByKey(key: string): Promise<ProfileFieldView | null> {
    const row = await this.prisma.client.profileField.findFirst({
      where: { key },
      select: SELECT,
    });
    return row ? toView(row) : null;
  }

  async createGeneralField(input: {
    key: string;
    label: string;
    value: string | null;
  }): Promise<ProfileFieldView> {
    const row = await this.prisma.client.profileField.create({
      data: stampedByTenant<Prisma.ProfileFieldUncheckedCreateInput>({
        key: input.key,
        label: input.label,
        value: input.value,
        visibility: 'GENERAL',
      }),
      select: SELECT,
    });
    return toView(row);
  }

  async createSensitiveField(input: {
    key: string;
    label: string;
    envelope: CipherEnvelope;
  }): Promise<ProfileFieldView> {
    const clientId = this.requireTenant();
    const row = await this.prisma.client.profileField.create({
      data: stampedByTenant<Prisma.ProfileFieldUncheckedCreateInput>({
        key: input.key,
        label: input.label,
        value: null,
        visibility: 'SENSITIVE',
        sensitive: {
          create: {
            // SensitiveValue is tenant-scoped, but a nested create is not
            // intercepted by the extension the way a top-level one is, so the
            // tenant is stamped explicitly here.
            clientId,
            ...envelopeData(input.envelope),
          },
        },
      }),
      select: SELECT,
    });
    return toView(row);
  }

  async updateGeneralValue(id: string, value: string | null): Promise<ProfileFieldView> {
    const row = await this.prisma.client.profileField.update({
      where: { id },
      data: { value },
      select: SELECT,
    });
    return toView(row);
  }

  async updateLabel(id: string, label: string): Promise<ProfileFieldView> {
    const row = await this.prisma.client.profileField.update({
      where: { id },
      data: { label },
      select: SELECT,
    });
    return toView(row);
  }

  async updateSensitiveValue(
    id: string,
    envelope: CipherEnvelope,
  ): Promise<ProfileFieldView> {
    const clientId = this.requireTenant();
    const row = await this.prisma.client.profileField.update({
      where: { id },
      data: {
        value: null,
        sensitive: {
          upsert: {
            create: { clientId, ...envelopeData(envelope) },
            update: envelopeData(envelope),
          },
        },
      },
      select: SELECT,
    });
    return toView(row);
  }

  async promoteToSensitive(
    id: string,
    envelope: CipherEnvelope,
  ): Promise<ProfileFieldView> {
    const clientId = this.requireTenant();
    // One transaction: the ciphertext appears and the plaintext column is
    // nulled together, or neither happens.
    const row = await this.prisma.client.profileField.update({
      where: { id },
      data: {
        visibility: 'SENSITIVE',
        value: null,
        sensitive: {
          upsert: {
            create: { clientId, ...envelopeData(envelope) },
            update: envelopeData(envelope),
          },
        },
      },
      select: SELECT,
    });
    return toView(row);
  }

  async demoteToGeneral(id: string, plaintext: string): Promise<ProfileFieldView> {
    const row = await this.prisma.client.profileField.update({
      where: { id },
      data: {
        visibility: 'GENERAL',
        value: plaintext,
        sensitive: { delete: true },
      },
      select: SELECT,
    });
    return toView(row);
  }

  async deleteField(id: string): Promise<void> {
    // SensitiveValue cascades on the relation, so the ciphertext goes with it.
    await this.prisma.client.profileField.delete({ where: { id } });
  }

  async getNarrative(): Promise<{ body: string; updatedAt: Date } | null> {
    const clientId = this.requireTenant();
    return this.prisma.client.experienceNarrative.findUnique({
      where: { clientId },
      select: { body: true, updatedAt: true },
    });
  }

  async upsertNarrative(body: string): Promise<{ body: string; updatedAt: Date }> {
    const clientId = this.requireTenant();
    return this.prisma.client.experienceNarrative.upsert({
      where: { clientId },
      create: { clientId, body },
      update: { body },
      select: { body: true, updatedAt: true },
    });
  }

  /**
   * ExperienceNarrative and nested SensitiveValue creates are keyed by clientId
   * directly, so the tenant is read explicitly rather than relying on the
   * extension's where-injection.
   */
  private requireTenant(): string {
    const clientId = currentTenant()?.clientId;
    if (!clientId) throw new Error('No tenant context for a profile write');
    return clientId;
  }
}

function envelopeData(e: CipherEnvelope) {
  return {
    ciphertext: toBytes(e.ciphertext),
    iv: toBytes(e.iv),
    authTag: toBytes(e.authTag),
    keyVersion: e.keyVersion,
  };
}
