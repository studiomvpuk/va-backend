import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../core/persistence/prisma.service';
import { toBytes } from '../core/persistence/bytes';
import { currentTenant } from '../core/tenancy/tenant.context';
import {
  CREDENTIAL_CIPHER,
  type ICredentialCipher,
} from '../core/crypto/cipher.interface';
import { AUDIT_LOGGER, type IAuditLogger } from '../core/audit/audit.interface';
import type {
  ICredentialRevealer,
  ICredentialWriter,
  RevealedCredential,
  StoredCredentialMeta,
} from './credential.repository';
import type { CipherEnvelope } from '../core/crypto/cipher.interface';

/**
 * Same shape as the sensitive-value repository, for the same reason: the
 * decrypt and the audit write share one transaction, so a reveal that was not
 * logged is not a reveal that happened.
 *
 * The transaction handle is deliberately left to inference rather than
 * described by a hand-written interface. A hand-written one stopped matching
 * the generated client, which made TypeScript fall through to the array form of
 * `$transaction` and infer the result as `any[]` — silently switching off
 * checking on exactly the method that must not be got wrong.
 */

@Injectable()
export class PrismaCredentialRepository
  implements ICredentialRevealer, ICredentialWriter
{
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CREDENTIAL_CIPHER) private readonly cipher: ICredentialCipher,
    @Inject(AUDIT_LOGGER) private readonly audit: IAuditLogger,
  ) {}

  // ───────────────────────────────────────────────────────── VA-reachable

  async revealForSite(input: {
    siteId: string;
    vaId: string;
    ipAddress?: string;
    ttlSeconds: number;
  }): Promise<RevealedCredential | null> {
    const clientId = this.requireTenant();
    const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);

    return this.prisma.client.$transaction(async (tx) => {
      // One site by id. The tenant extension has already constrained this to
      // the caller's Client, so a VA cannot name another tenant's site.
      const site = await tx.site.findUnique({
        where: { id: input.siteId },
        select: {
          name: true,
          username: true,
          credential: {
            select: {
              id: true,
              ciphertext: true,
              iv: true,
              authTag: true,
              keyVersion: true,
            },
          },
        },
      });

      if (!site?.credential) return null;

      const reveal = await tx.credentialReveal.create({
        data: {
          clientId,
          credentialId: site.credential.id,
          vaId: input.vaId,
          expiresAt,
          ipAddress: input.ipAddress ?? null,
        },
        select: { id: true },
      });

      // Logged before the plaintext exists in this scope. If this throws, the
      // transaction rolls back and no password was ever produced.
      await this.audit.record(
        {
          action: 'credential.revealed',
          subjectType: 'Site',
          subjectId: input.siteId,
          metadata: {
            siteName: site.name,
            vaId: input.vaId,
            revealId: reveal.id,
            expiresAt: expiresAt.toISOString(),
          },
          ipAddress: input.ipAddress,
        },
        tx,
      );

      const password = await this.cipher.decrypt({
        ciphertext: Buffer.from(site.credential.ciphertext),
        iv: Buffer.from(site.credential.iv),
        authTag: Buffer.from(site.credential.authTag),
        keyVersion: site.credential.keyVersion,
      });

      return {
        revealId: reveal.id,
        siteName: site.name,
        username: site.username,
        password,
        expiresAt,
      };
    });
  }

  // ─────────────────────────────────────────────────────── Client-side only

  async put(siteId: string, envelope: CipherEnvelope, rotated: boolean): Promise<void> {
    const clientId = this.requireTenant();
    const data = {
      ciphertext: toBytes(envelope.ciphertext),
      iv: toBytes(envelope.iv),
      authTag: toBytes(envelope.authTag),
      keyVersion: envelope.keyVersion,
      ...(rotated ? { rotatedAt: new Date() } : {}),
    };
    await this.prisma.client.credential.upsert({
      where: { siteId },
      create: { clientId, siteId, ...data },
      update: data,
    });
    await this.prisma.client.site.update({
      where: { id: siteId },
      data: { status: 'CONNECTED' },
    });
  }

  async remove(siteId: string): Promise<void> {
    await this.prisma.client.credential.deleteMany({ where: { siteId } });
    await this.prisma.client.site.update({
      where: { id: siteId },
      data: { status: 'NOT_CONNECTED' },
    });
  }

  async findMeta(siteId: string): Promise<StoredCredentialMeta | null> {
    const row = await this.prisma.client.credential.findUnique({
      where: { siteId },
      select: META,
    });
    return row ? toMeta(row) : null;
  }

  async listMeta(): Promise<StoredCredentialMeta[]> {
    // Metadata only. This returns many rows and is Client-side by design —
    // it carries no ciphertext and no password, which is what makes that safe.
    const rows = await this.prisma.client.credential.findMany({ select: META });
    return (rows as MetaRow[]).map(toMeta);
  }

  async supersedeLiveReveals(credentialId: string): Promise<number> {
    const { count } = await this.prisma.client.credentialReveal.updateMany({
      where: { credentialId, expiresAt: { gt: new Date() }, supersededAt: null },
      data: { supersededAt: new Date() },
    });
    return count;
  }

  async acknowledgeUnrotated(credentialId: string, vaId: string): Promise<void> {
    const clientId = this.requireTenant();
    await this.prisma.client.credentialAcknowledgement.upsert({
      where: { credentialId_vaId: { credentialId, vaId } },
      create: { clientId, credentialId, vaId },
      update: {},
    });
  }

  async hasAcknowledgement(credentialId: string, vaId: string): Promise<boolean> {
    const row = await this.prisma.client.credentialAcknowledgement.findUnique({
      where: { credentialId_vaId: { credentialId, vaId } },
      select: { id: true },
    });
    return row !== null;
  }

  async isRevealSuperseded(revealId: string): Promise<boolean> {
    const row = await this.prisma.client.credentialReveal.findUnique({
      where: { id: revealId },
      select: { supersededAt: true },
    });
    return row?.supersededAt != null;
  }

  private requireTenant(): string {
    const clientId = currentTenant()?.clientId;
    if (!clientId) throw new Error('No tenant context for a vault operation');
    return clientId;
  }
}

const META = {
  id: true,
  siteId: true,
  rotatedAt: true,
  createdAt: true,
} as const;

interface MetaRow {
  id: string;
  siteId: string;
  rotatedAt: Date | null;
  createdAt: Date;
}

function toMeta(row: MetaRow): StoredCredentialMeta {
  // A row existing IS the password existing — there is no nullable password
  // column, so this needs no ciphertext read to answer.
  return { ...row, hasPassword: true };
}
