import type { CipherEnvelope } from '../core/crypto/cipher.interface';

/**
 * The ONLY interface in the codebase that can return a sensitive ciphertext.
 *
 * ── A refinement of PRD §2.5, stated precisely ───────────────────────────────
 * The PRD says SensitiveValue's repository is "provided only inside
 * DisclosureModule and is not exported". That is not quite implementable as
 * written: ProfileModule has to WRITE sensitive values when a Client flags a
 * field, and writing cannot be routed through a read-only disclosure path.
 *
 * The invariant that actually matters is narrower and stronger:
 *
 *     There is exactly one code path that turns a stored ciphertext back into
 *     plaintext, and it writes an audit row in the same transaction.
 *
 * You cannot leak data by writing it. So writes live with the profile, reads
 * live here, and `test/architecture/sensitive-reads.spec.ts` fails CI if any
 * file outside this directory reads the ciphertext column.
 */
export interface ISensitiveValueReader {
  /**
   * Decrypts one field's value and records the disclosure atomically.
   *
   * There is deliberately no findMany, no "reveal all", and no method that
   * takes an array. One call, one field, one audit row.
   */
  reveal(input: {
    profileFieldId: string;
    /** Why — goes into the audit metadata verbatim. */
    reason: string;
    /** Who the value is being shown to. */
    disclosedTo: { actorType: 'CLIENT' | 'VA'; actorId: string };
    /** The screening question that matched, when there is one (Phase 6). */
    questionText?: string;
    applicationId?: string;
  }): Promise<string | null>;
}

/**
 * Writes. Exported to ProfileModule; cannot read anything back.
 */
export interface ISensitiveValueWriter {
  /** Stores or replaces the encrypted value for a field. */
  put(profileFieldId: string, envelope: CipherEnvelope): Promise<void>;
  /** Removes it — used when a field is demoted to general, or deleted. */
  remove(profileFieldId: string): Promise<void>;
  /** True when a field has an encrypted value, WITHOUT decrypting it. */
  exists(profileFieldId: string): Promise<boolean>;
}

export const SENSITIVE_VALUE_READER = Symbol('SENSITIVE_VALUE_READER');
export const SENSITIVE_VALUE_WRITER = Symbol('SENSITIVE_VALUE_WRITER');
