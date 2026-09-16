/**
 * Rejects government identity numbers at the API boundary.
 *
 * PRD §8: "True highest-risk categories (government ID numbers) should not be
 * stored in this system regardless of flagging." Sensitivity flagging is for
 * things like an address or salary history — data that is legitimately needed
 * sometimes. A National Insurance number is never needed to fill in a job
 * application, and storing one converts a credential-theft problem into an
 * identity-theft problem.
 *
 * ── On false positives ───────────────────────────────────────────────────────
 * Refusing to save something a Client legitimately typed is a real harm, not a
 * neutral safe default. A CV full of dates, phone numbers, postcodes and
 * reference numbers has a lot of digit strings in it, and a naive `\d{9}`
 * would reject half of them.
 *
 * So every detector here is high-confidence: it either validates a checksum, or
 * applies the issuing authority's own structural rules, or requires a keyword
 * in context. A bare nine-digit number is NOT treated as an SSN, because most
 * nine-digit numbers are not SSNs.
 */

export type GovernmentIdKind =
  | 'uk_national_insurance'
  | 'uk_nhs_number'
  | 'us_social_security'
  | 'passport_number';

export interface GovernmentIdMatch {
  kind: GovernmentIdKind;
  /** Human-readable name for the error message. Never echoes the value back. */
  label: string;
}

const LABELS: Record<GovernmentIdKind, string> = {
  uk_national_insurance: 'a National Insurance number',
  uk_nhs_number: 'an NHS number',
  us_social_security: 'a Social Security number',
  passport_number: 'a passport number',
};

/* ── UK National Insurance ──────────────────────────────────────────────────
 * Two prefix letters, six digits, one suffix letter A–D. HMRC excludes D, F,
 * I, Q, U and V from the first letter; the same plus O from the second; and
 * reserves the prefixes BG, GB, NK, KN, TN, NT and ZZ. Those rules together
 * make the pattern specific enough to stand on its own. */
const NINO = /\b[ABCEGHJ-PRSTW-Z][ABCEGHJ-NPRSTW-Z]\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]?\b/i;
const NINO_RESERVED = new Set(['BG', 'GB', 'NK', 'KN', 'TN', 'NT', 'ZZ']);

/* ── NHS number ─────────────────────────────────────────────────────────────
 * Ten digits with a modulus-11 check digit. The checksum is what makes this
 * safe to detect without context — a random ten-digit number passes roughly
 * one time in eleven, and requiring the conventional 3-3-4 grouping or a
 * keyword removes most of what remains. */
const NHS_CANDIDATE = /\b(\d{3})[\s-]?(\d{3})[\s-]?(\d{4})\b/g;

/* ── US Social Security ─────────────────────────────────────────────────────
 * The dashed form is distinctive. Undashed nine-digit runs are only treated as
 * an SSN when a keyword appears nearby, because otherwise every employee
 * number and order reference would trip it. */
const SSN_DASHED = /\b(\d{3})-(\d{2})-(\d{4})\b/;
const SSN_BARE = /\b(\d{3})(\d{2})(\d{4})\b/;
const SSN_KEYWORD = /\b(ssn|social\s*security)\b/i;

/* ── Passport ───────────────────────────────────────────────────────────────
 * Passport numbers have no checksum and no distinctive shape — a nine-character
 * alphanumeric run matches far too much. Keyword-gated only. */
const PASSPORT_KEYWORD = /\bpassport\s*(?:no\.?|number|#)?\s*[:-]?\s*([A-Z0-9]{8,9})\b/i;

/** Modulus-11 check digit, as specified by NHS Digital. */
export function isValidNhsNumber(digits: string): boolean {
  if (!/^\d{10}$/.test(digits)) return false;

  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(digits[i]) * (10 - i);

  const remainder = sum % 11;
  const check = 11 - remainder;
  // 10 is not a valid check digit — such numbers are simply not issued.
  if (check === 10) return false;
  return (check === 11 ? 0 : check) === Number(digits[9]);
}

/** Structural rules the SSA does not issue against. */
export function isPlausibleSsn(area: string, group: string, serial: string): boolean {
  if (area === '000' || area === '666' || Number(area) >= 900) return false;
  if (group === '00') return false;
  if (serial === '0000') return false;
  return true;
}

function ninoPrefixAllowed(value: string): boolean {
  const prefix = value.replace(/\s/g, '').slice(0, 2).toUpperCase();
  return !NINO_RESERVED.has(prefix);
}

/**
 * Returns the first government ID found, or null.
 *
 * @param text The value being stored.
 * @param context Adjacent text — a field label, say — that may supply the
 *   keyword the ambiguous detectors need. Passing the label means
 *   "Social Security Number: 123456789" is caught while a bare order number is
 *   not.
 */
export function detectGovernmentId(
  text: string,
  context = '',
): GovernmentIdMatch | null {
  if (!text) return null;
  const haystack = `${context} ${text}`;

  const nino = NINO.exec(text);
  if (nino && ninoPrefixAllowed(nino[0])) {
    return { kind: 'uk_national_insurance', label: LABELS.uk_national_insurance };
  }

  // NHS: a valid checksum, plus either the conventional grouping or a keyword.
  const grouped = /\b\d{3}[\s-]\d{3}[\s-]\d{4}\b/.test(text);
  const nhsKeyword = /\bnhs\b/i.test(haystack);
  if (grouped || nhsKeyword) {
    NHS_CANDIDATE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = NHS_CANDIDATE.exec(text)) !== null) {
      if (isValidNhsNumber(m[1] + m[2] + m[3])) {
        return { kind: 'uk_nhs_number', label: LABELS.uk_nhs_number };
      }
    }
  }

  const dashed = SSN_DASHED.exec(text);
  if (dashed && isPlausibleSsn(dashed[1], dashed[2], dashed[3])) {
    return { kind: 'us_social_security', label: LABELS.us_social_security };
  }

  if (SSN_KEYWORD.test(haystack)) {
    const bare = SSN_BARE.exec(text);
    if (bare && isPlausibleSsn(bare[1], bare[2], bare[3])) {
      return { kind: 'us_social_security', label: LABELS.us_social_security };
    }
  }

  if (PASSPORT_KEYWORD.test(haystack) && /[A-Z0-9]{8,9}/i.test(text)) {
    return { kind: 'passport_number', label: LABELS.passport_number };
  }

  return null;
}

/**
 * The message shown to the Client.
 *
 * Says what was found and why it is refused, without repeating the value — an
 * error message ends up in logs, and echoing the number back would put it
 * exactly where this check exists to keep it out of.
 */
export function governmentIdRejectionMessage(match: GovernmentIdMatch): string {
  return (
    `This looks like ${match.label}. This system does not store government ID ` +
    `numbers at all, even marked as sensitive — they are never needed to complete ` +
    `a job application, and keeping them would turn a password problem into an ` +
    `identity-theft problem. Please remove it and save again.`
  );
}
