import { createHash } from 'node:crypto';

/**
 * The confidentiality agreement a VA signs before reaching anything.
 *
 * Versioned as data rather than stored in a database row, for one reason: the
 * signature record keeps a sha256 of the exact text shown, and a hash is only
 * worth keeping if the text it hashes is immutable and recoverable. Text living
 * in a table someone can UPDATE makes "what did they actually agree to" a
 * question nobody can answer afterwards.
 *
 * Changing the wording means adding a version. The old one stays, forever,
 * because someone signed it.
 *
 * NOT LEGAL ADVICE. This is a plain-language in-product agreement modelled on
 * the Letter of Engagement described in the PRD. Before relying on it as an
 * enforceable contract — particularly across jurisdictions, which this product
 * will be, with a UK client and Nigerian assistants — have a solicitor review
 * it. Treat the current text as a placeholder that behaves correctly rather
 * than as settled drafting.
 */

export interface AgreementVersion {
  version: string;
  effectiveFrom: string;
  title: string;
  body: string;
}

const V1: AgreementVersion = {
  version: '1.0.0',
  effectiveFrom: '2026-09-16',
  title: 'Confidentiality and Discreet Handling Agreement',
  body: `
This agreement is between the account owner (the "Client") and you (the
"Assistant"). You are being given access to information about the Client so that
you can submit job applications on their behalf. By signing, you agree to the
following.

1. WHAT YOU WILL SEE
You will see the Client's professional background, the job boards they have
approved, and — for one site at a time, when you are actively working on it —
the password for that site's account. You will not see their full profile
document, and you will not see information they have marked as protected unless
a specific application question genuinely requires it.

2. CONFIDENTIALITY
Everything you learn through this system belongs to the Client. You will not
share it, publish it, sell it, discuss it outside this system, or use it for any
purpose other than submitting applications on the Client's behalf. This
continues to apply after your work for the Client ends.

3. PASSWORDS AND ACCOUNT ACCESS
When you are shown a password, it is for the one site named, for the task in
front of you. You will not write it down, store it, reuse it, share it, or use
it to sign in for any purpose other than submitting an application for the
Client. You will not attempt to access any account, site or service the Client
has not listed.

Every time a password is shown to you, it is recorded: which site, which
assistant, when, and from where. The Client can see that record.

4. ACTING AS THE CLIENT
When you apply on the Client's behalf you are representing a real person's
career. You will not misrepresent their experience, invent qualifications, or
submit applications to roles outside what they have asked for.

5. THE CLIENT'S DATA STAYS WITH THE CLIENT
You will not copy the Client's information into any other system, document,
spreadsheet or tool. If you need something to do your job and cannot see it,
ask through this system rather than working around it.

6. ENDING ACCESS
The Client can revoke your access at any moment, without notice and without
giving a reason. When they do, your sessions end immediately. Your obligations
under this agreement do not end with your access.

7. IF SOMETHING GOES WRONG
If you believe information has been exposed — a password shared by mistake, a
device lost, an account compromised — tell the Client immediately. Telling them
promptly is always better than hoping it goes unnoticed.

By signing below you confirm that you have read this agreement, that you
understand it, and that you agree to be bound by it.
`.trim(),
};

const VERSIONS: Record<string, AgreementVersion> = {
  [V1.version]: V1,
};

/** The version a new signature is taken against. */
export const CURRENT_AGREEMENT_VERSION = V1.version;

export function getAgreementVersion(version: string): AgreementVersion {
  const found = VERSIONS[version];
  if (!found) {
    // A signature referencing a version that no longer exists means someone
    // deleted history, which is the thing this design exists to prevent.
    throw new Error(
      `Unknown agreement version "${version}". Versions are append-only — an ` +
        `existing signature references this and its text must not be removed.`,
    );
  }
  return found;
}

export function getCurrentAgreement(): AgreementVersion {
  return getAgreementVersion(CURRENT_AGREEMENT_VERSION);
}

export function listAgreementVersions(): string[] {
  return Object.keys(VERSIONS);
}

/**
 * Hashes the exact text a signer was shown.
 *
 * Normalises line endings only. Nothing else — no trimming per line, no
 * whitespace collapsing — because the point is to hash what was displayed, and
 * a "helpful" normalisation is a way for the stored hash to stop matching the
 * stored text.
 */
export function hashAgreementText(body: string): string {
  return createHash('sha256').update(body.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/** Re-hashes a stored version and compares. The proof, after the fact. */
export function verifyAgreementHash(version: string, storedHash: string): boolean {
  return hashAgreementText(getAgreementVersion(version).body) === storedHash;
}
