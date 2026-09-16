import { SetMetadata } from '@nestjs/common';

export const AGREEMENT_EXEMPT = 'va:agreement-exempt';

/**
 * Lets a VA route run before the agreement is signed.
 *
 * There are exactly three legitimate uses, and they are the routes that make
 * signing possible at all: accepting the invitation, fetching the agreement
 * text, and submitting the signature. Everything else waits.
 *
 * Like @Public(), this is the ONLY way past the gate, which makes every
 * exemption in the codebase greppable in one command — and
 * `test/architecture/va-agreement-gate.spec.ts` pins the list, so a fourth
 * exemption is a decision someone reviews rather than a decorator added on a
 * Friday.
 */
export const AgreementExempt = () => SetMetadata(AGREEMENT_EXEMPT, true);
