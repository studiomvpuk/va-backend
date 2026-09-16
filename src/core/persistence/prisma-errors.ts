/**
 * Prisma error codes, named once.
 *
 * `isUniqueViolation` had been written out three times — in the account, QA-bank
 * and prep repositories — and a fourth was about to be added for sites. Three
 * copies is where a rule stops being a rule: the site repository did not have
 * one at all, so a duplicate site name escaped as an unhandled
 * `PrismaClientKnownRequestError` and Nest returned a 500 for what is plainly a
 * user's typo.
 *
 * Codes are matched structurally rather than by `instanceof
 * PrismaClientKnownRequestError`. The generated client is regenerated from the
 * schema and its error classes are not stable identities across that boundary;
 * the codes are documented API and do not move.
 */

const hasCode = (e: unknown, code: string): boolean =>
  typeof e === 'object' &&
  e !== null &&
  'code' in e &&
  (e as { code?: unknown }).code === code;

/** P2002 — a unique constraint rejected the write. */
export const isUniqueViolation = (e: unknown): boolean => hasCode(e, 'P2002');

/** P2025 — the row the operation needed was not there. */
export const isRecordNotFound = (e: unknown): boolean => hasCode(e, 'P2025');

/** P2003 — a foreign key pointed at a row that does not exist. */
export const isForeignKeyViolation = (e: unknown): boolean => hasCode(e, 'P2003');
