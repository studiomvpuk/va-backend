/**
 * The §7.4 pre-onboarding rotation gate.
 *
 * The product's largest liability is that a VA sees a real password in
 * plaintext. v10 recommended using a dedicated per-purpose account; this makes
 * it an active step instead of advice nobody reads.
 *
 * Before a credential is revealable to a newly onboarded VA, one of:
 *
 *   (a) the password was set or rotated AFTER that VA was onboarded — so the VA
 *       has never seen the value the Client was using before they arrived; or
 *   (b) the Client explicitly dismissed a warning saying this VA will see the
 *       current password, and that dismissal was recorded.
 *
 * Note (a) is a timestamp comparison, not a flag. A boolean would have to be
 * maintained correctly at every write site and can drift out of step with
 * reality; two timestamps cannot disagree with themselves.
 *
 * Scoped to the (credential, VA) pair: onboarding a second VA asks again,
 * because the first VA's acknowledgement says nothing about the second.
 */

export type GateVerdict =
  | { allowed: true; reason: 'rotated_after_onboarding' | 'acknowledged' }
  | { allowed: false; reason: 'needs_rotation_or_acknowledgement' };

export interface GateInput {
  /** When the stored password was last set or changed. */
  credentialSetAt: Date;
  credentialRotatedAt: Date | null;
  /** When this VA's account was created. */
  vaOnboardedAt: Date;
  hasAcknowledgement: boolean;
}

export function evaluateSharingGate(input: GateInput): GateVerdict {
  // The later of "created" and "rotated" is when the current value came into
  // existence. A credential added after the VA joined counts as fresh — there
  // is nothing to rotate, the VA has never seen it.
  const currentValueSetAt = Math.max(
    input.credentialSetAt.getTime(),
    input.credentialRotatedAt?.getTime() ?? 0,
  );

  if (currentValueSetAt > input.vaOnboardedAt.getTime()) {
    return { allowed: true, reason: 'rotated_after_onboarding' };
  }
  if (input.hasAcknowledgement) {
    return { allowed: true, reason: 'acknowledged' };
  }
  return { allowed: false, reason: 'needs_rotation_or_acknowledgement' };
}

export const GATE_BLOCKED_MESSAGE =
  'This password has not been changed since this assistant was onboarded, so ' +
  'they would see the value you were already using. Rotate it first — the vault ' +
  'makes that one click — or confirm explicitly that you want to share the ' +
  'current one. Either way the decision is recorded.';
