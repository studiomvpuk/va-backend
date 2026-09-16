import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../core/persistence/prisma.service';
import { toBytes } from '../core/persistence/bytes';
import { stampedByTenant } from '../core/tenancy/tenant-stamped';
import {
  CREDENTIAL_CIPHER,
  type ICredentialCipher,
} from '../core/crypto/cipher.interface';
import { AUDIT_LOGGER, type IAuditLogger } from '../core/audit/audit.interface';
import type {
  ISensitiveValueReader,
  ISensitiveValueWriter,
} from './sensitive-value.repository';
import type { CipherEnvelope } from '../core/crypto/cipher.interface';

/**
 * The slice of the transactional client this repository uses.
 *
 * Named explicitly rather than inferred so the audit logger and the read are
 * visibly bound to the SAME transaction handle — that binding is the guarantee
 * this whole class exists to provide.
 */
interface TransactionClient {
  sensitiveValue: {
    findUnique(args: unknown): Promise<{
      ciphertext: Uint8Array;
      iv: Uint8Array;
      authTag: Uint8Array;
      keyVersion: number;
    } | null>;
  };
}

/**
 * The one door.
 *
 * `reveal` decrypts and logs inside a single transaction. If the audit write
 * fails, the transaction rolls back and the caller gets an error rather than a
 * plaintext value — so a disclosure that was not logged is not a disclosure
 * that happened. That ordering is the whole point and is covered by a test.
 */
@Injectable()
export class PrismaSensitiveValueRepository
  implements ISensitiveValueReader, ISensitiveValueWriter
{
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CREDENTIAL_CIPHER) private readonly cipher: ICredentialCipher,
    @Inject(AUDIT_LOGGER) private readonly audit: IAuditLogger,
  ) {}

  async reveal(input: {
    profileFieldId: string;
    reason: string;
    disclosedTo: { actorType: 'CLIENT' | 'VA'; actorId: string };
    questionText?: string;
    applicationId?: string;
  }): Promise<string | null> {
    return this.prisma.client.$transaction(async (tx: TransactionClient) => {
      const row = await tx.sensitiveValue.findUnique({
        where: { profileFieldId: input.profileFieldId },
        select: { ciphertext: true, iv: true, authTag: true, keyVersion: true },
      });
      if (!row) return null;

      // Log BEFORE returning. Both statements are in the same transaction, so
      // a failure here means the caller never sees the plaintext either.
      await this.audit.record(
        {
          action: 'sensitive.disclosed',
          subjectType: 'ProfileField',
          subjectId: input.profileFieldId,
          metadata: {
            reason: input.reason,
            disclosedToType: input.disclosedTo.actorType,
            disclosedToId: input.disclosedTo.actorId,
            // The question is logged; the VALUE never is.
            ...(input.questionText ? { questionText: input.questionText } : {}),
            ...(input.applicationId ? { applicationId: input.applicationId } : {}),
          },
        },
        tx,
      );

      return this.cipher.decrypt({
        ciphertext: Buffer.from(row.ciphertext),
        iv: Buffer.from(row.iv),
        authTag: Buffer.from(row.authTag),
        keyVersion: row.keyVersion,
      });
    });
  }

  async put(profileFieldId: string, envelope: CipherEnvelope): Promise<void> {
    // The extension stamps clientId onto the create half of an upsert.
    const fields = envelopeData(envelope);
    await this.prisma.client.sensitiveValue.upsert({
      where: { profileFieldId },
      create: stampedByTenant<Prisma.SensitiveValueUncheckedCreateInput>({
        profileFieldId,
        ...fields,
      }),
      update: fields,
    });
  }

  async remove(profileFieldId: string): Promise<void> {
    await this.prisma.client.sensitiveValue.deleteMany({ where: { profileFieldId } });
  }

  async exists(profileFieldId: string): Promise<boolean> {
    // Selects the id, never the ciphertext — "is it set" is not a disclosure
    // and must not be routed through the audited path.
    const row = await this.prisma.client.sensitiveValue.findUnique({
      where: { profileFieldId },
      select: { id: true },
    });
    return row !== null;
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
