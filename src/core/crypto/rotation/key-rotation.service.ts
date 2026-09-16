import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../persistence/prisma.service';
import { runUnscoped } from '../../tenancy/tenant.context';
import { CREDENTIAL_CIPHER, type ICredentialCipher } from '../cipher.interface';

/**
 * Every table that stores a CipherEnvelope.
 *
 * Enumerated rather than discovered, and an architecture test checks this list
 * against the schema. A table added with a `ciphertext` column and not added
 * here would be silently skipped by every rotation — its rows would stay on the
 * retiring key, and the failure would surface as an UnknownKeyVersionError
 * weeks later when someone removed that key from the environment.
 */
export const ENCRYPTED_TABLES = ['sensitiveValue', 'credential', 'providerKey'] as const;
export type EncryptedTable = (typeof ENCRYPTED_TABLES)[number];

export interface RotationReport {
  toVersion: number;
  readableVersions: number[];
  /** Rows moved, per table. */
  rotated: Record<string, number>;
  /** Rows still on an older version after this run. */
  remaining: Record<string, number>;
  failures: { table: string; id: string; reason: string }[];
  /** True when nothing is left on an old key and it can be removed. */
  previousKeyRetirable: boolean;
}

/** Small enough that one failure loses little work; large enough to be quick. */
const BATCH = 200;

/**
 * Re-encrypts every stored secret under the current key.
 *
 * ── Why this runs unscoped ──────────────────────────────────────────────────
 * It is an operator task across every tenant, which is the second legitimate
 * use of `runUnscoped` in the codebase — the first being auth bootstrap. Both
 * are in the architecture test's allowlist with a written reason, which is what
 * makes adding a third one a decision somebody reviews.
 *
 * ── Why it is resumable and idempotent ──────────────────────────────────────
 * It only ever selects rows not already on the current version, so running it
 * twice does nothing the second time, and an interrupted run continues from
 * where it stopped. There is no progress table to keep in step with reality —
 * the rows themselves are the progress.
 *
 * ── Why one row per transaction ─────────────────────────────────────────────
 * A batch transaction would be faster and would make a crash mid-batch roll
 * back work that was already correct. More importantly, a single transaction
 * spanning thousands of rows holds locks on the credential table while VAs are
 * trying to read from it. Rotation is a background chore; it yields.
 */
@Injectable()
export class KeyRotationService {
  private readonly logger = new Logger(KeyRotationService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CREDENTIAL_CIPHER) private readonly cipher: ICredentialCipher,
  ) {}

  async rotate(options: { dryRun?: boolean } = {}): Promise<RotationReport> {
    const toVersion = this.cipher.currentKeyVersion;

    const report: RotationReport = {
      toVersion,
      readableVersions: this.cipher.readableKeyVersions,
      rotated: {},
      remaining: {},
      failures: [],
      previousKeyRetirable: false,
    };

    for (const table of ENCRYPTED_TABLES) {
      const { rotated, failures } = await this.rotateTable(table, toVersion, options.dryRun ?? false);
      report.rotated[table] = rotated;
      report.failures.push(...failures);
      report.remaining[table] = await this.countStale(table, toVersion);
    }

    report.previousKeyRetirable =
      report.failures.length === 0 &&
      Object.values(report.remaining).every((count) => count === 0);

    return report;
  }

  /** What a rotation would do, without doing it. */
  status(): Promise<RotationReport> {
    return this.rotate({ dryRun: true });
  }

  private async rotateTable(
    table: EncryptedTable,
    toVersion: number,
    dryRun: boolean,
  ): Promise<{ rotated: number; failures: RotationReport['failures'] }> {
    const failures: RotationReport['failures'] = [];
    let rotated = 0;

    for (;;) {
      const batch = await runUnscoped(
        () =>
          this.model(table).findMany({
            where: { keyVersion: { not: toVersion } },
            select: { id: true, ciphertext: true, iv: true, authTag: true, keyVersion: true },
            take: BATCH,
          }) as Promise<EncryptedRow[]>,
        'key rotation: re-encrypt every tenant’s stored secrets',
      );

      if (batch.length === 0) break;
      if (dryRun) return { rotated: batch.length, failures };

      for (const row of batch) {
        try {
          const plaintext = await this.cipher.decrypt({
            ciphertext: Buffer.from(row.ciphertext),
            iv: Buffer.from(row.iv),
            authTag: Buffer.from(row.authTag),
            keyVersion: row.keyVersion,
          });
          const envelope = await this.cipher.encrypt(plaintext);

          await runUnscoped(
            () =>
              this.model(table).update({
                // Guarded on the old version: if another process rotated this
                // row in between, this updates nothing rather than overwriting
                // a newer envelope with one derived from stale plaintext.
                where: { id: row.id, keyVersion: row.keyVersion },
                data: {
                  ciphertext: envelope.ciphertext,
                  iv: envelope.iv,
                  authTag: envelope.authTag,
                  keyVersion: envelope.keyVersion,
                },
              }),
            'key rotation: write the re-encrypted envelope',
          );
          rotated++;
        } catch (e) {
          // One unreadable row must not stop the rotation. It is reported by id
          // so it can be investigated, and the run continues — the alternative
          // is that a single corrupt record blocks every other row forever.
          const reason = e instanceof Error ? e.message : String(e);
          failures.push({ table, id: row.id, reason });
          this.logger.error(`${table} ${row.id}: ${reason}`);
        }
      }

      // Every row in the batch failed: another pass would fetch the same rows
      // and fail identically.
      if (rotated === 0 && failures.length >= batch.length) break;
    }

    return { rotated, failures };
  }

  private countStale(table: EncryptedTable, toVersion: number): Promise<number> {
    return runUnscoped(
      () =>
        this.model(table).count({
          where: { keyVersion: { not: toVersion } },
        }) as Promise<number>,
      'key rotation: count rows still on a retiring key',
    );
  }

  private model(table: EncryptedTable): PrismaEncryptedModel {
    return (this.prisma.client as unknown as Record<string, PrismaEncryptedModel>)[table];
  }
}

interface EncryptedRow {
  id: string;
  ciphertext: Uint8Array;
  iv: Uint8Array;
  authTag: Uint8Array;
  keyVersion: number;
}

interface PrismaEncryptedModel {
  findMany(args: unknown): Promise<unknown>;
  update(args: unknown): Promise<unknown>;
  count(args: unknown): Promise<unknown>;
}
