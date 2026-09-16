import type { ActorType } from '../tenancy/tenant.context';

/**
 * The append-only audit log.
 *
 * Deliberately write-only from the application's perspective: this interface
 * has no update and no delete, and the service that implements it exposes none
 * either. An audit trail that can be edited by the code it audits is not an
 * audit trail.
 */

export type AuditAction =
  | 'credential.revealed'
  | 'credential.rotated'
  | 'credential.shared_without_rotation'
  | 'sensitive.disclosed'
  | 'agreement.signed'
  | 'va.invited'
  | 'va.revoked'
  | 'knowledge_gap.answered'
  | 'settings.changed'
  | 'byok_key.set';

export interface AuditEntry {
  action: AuditAction;
  subjectType: string;
  subjectId: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  /** Overrides the actor from tenant context. Only SYSTEM callers need this. */
  actor?: { type: ActorType; id: string };
}

export interface IAuditLogger {
  /**
   * Writes one audit event.
   *
   * @param tx Pass the surrounding transaction when the audited action and its
   *   log entry must succeed or fail together — which, for disclosures and
   *   credential reveals, they must (PRD §2.5). A disclosure that is not logged
   *   should not be a disclosure that happened.
   */
  record(entry: AuditEntry, tx?: unknown): Promise<void>;
}

export const AUDIT_LOGGER = Symbol('AUDIT_LOGGER');
