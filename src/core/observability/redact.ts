import { stripRegisteredSecrets } from './secret-registry';

export const REDACTED = '[redacted]';

/**
 * Three layers, because no one of them is sufficient.
 *
 *   1. Registered literals — the values this process holds (see
 *      secret-registry.ts). Catches secrets that look like nothing.
 *   2. Key names — a property called `password` is redacted whatever is in it.
 *      Catches a secret nobody registered, including one that arrived in a
 *      request body.
 *   3. Shapes — `sk-…`, `Bearer …`, a JWT. Catches a secret pasted into the
 *      middle of a sentence, where there is no key name to go on.
 *
 * ── What this is not ────────────────────────────────────────────────────────
 * It is not a reason to log secrets and trust the filter. It is the last line:
 * the thing that holds when someone logs an error object whose `cause` happens
 * to carry a request body three levels down. The first line is still not
 * putting the value in the log — and better still, not having it in a shape
 * that can be stringified at all.
 */

/** Redacted by name, whatever the value. Matched case-insensitively, anywhere in the key. */
const SENSITIVE_KEY = /pass(word|phrase)|secret|token|api[-_]?key|authorization|auth|cookie|ciphertext|credential|private[-_]?key|encryption[-_]?key|session|signature|dsn|otp|pin\b/i;

/**
 * Keys that LOOK sensitive by the rule above but carry nothing.
 *
 * Without these, the fields that make an incident diagnosable are the ones that
 * disappear: `tokenCount` is a number, `credentialId` is a cuid, and redacting
 * them means an on-call engineer cannot tell which credential was involved.
 */
const SAFE_KEY = /^(tokenCount|inputTokens|outputTokens|cachedInputTokens|credentialId|tokenId|sessionId|keyVersion|apiKeyId|hasValue|tokenFamily|authMethod|actorType)$/;

const SHAPES: RegExp[] = [
  // Provider keys: OpenAI sk-…, Anthropic sk-ant-…, Resend re_…, Brave BSA…
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bre_[A-Za-z0-9_-]{16,}/g,
  /\bBSA[A-Za-z0-9_-]{16,}/g,
  // Anything presented as a bearer credential.
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // A JWT, anywhere — including in a URL or an error message.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // argon2 / PHC-format hashes. Not reversible, still nobody's business.
  /\$argon2[a-z]{0,2}\$[^\s"']+/g,
  // A password inside a connection string: postgres://user:HERE@host
  /(?<=:\/\/[^:/\s]+:)[^@\s]+(?=@)/g,
];

/** Beyond this, an object is a payload rather than a log line. */
const MAX_DEPTH = 6;
const MAX_STRING = 4_000;

export function redactString(value: string): string {
  let result = stripRegisteredSecrets(value, REDACTED);
  for (const shape of SHAPES) result = result.replace(shape, REDACTED);
  return result.length > MAX_STRING ? `${result.slice(0, MAX_STRING)}…[truncated]` : result;
}

/**
 * Redacts anything loggable: strings, objects, arrays, Errors.
 *
 * Returns a new value; the caller's object is never mutated, because a logger
 * that edits the thing it was asked to log has changed the program.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return '[depth limit]';

  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value;
  }

  if (value instanceof Error) {
    // Message and stack both, and `cause`, which is where a provider response
    // body — the request that carried the key — ends up.
    const redacted: Record<string, unknown> = {
      name: value.name,
      message: redactString(value.message),
    };
    if (value.stack) redacted.stack = redactString(value.stack);
    if ('cause' in value && value.cause !== undefined) {
      redacted.cause = redact(value.cause, depth + 1);
    }
    return redacted;
  }

  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  if (value instanceof Map || value instanceof Set) {
    return redact([...value], depth + 1);
  }

  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (!SAFE_KEY.test(key) && SENSITIVE_KEY.test(key)) {
        // Kept as a marker rather than deleted: "there was an authorization
        // header and it is not shown" is more useful than silence, which reads
        // as "there was no header".
        result[key] = REDACTED;
        continue;
      }
      result[key] = redact(item, depth + 1);
    }
    return result;
  }

  // Functions, symbols — never meaningful in a log, and a function's source can
  // contain anything at all.
  return `[${typeof value}]`;
}
