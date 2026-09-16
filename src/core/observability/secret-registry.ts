/**
 * The literal secret values this process knows about.
 *
 * ── Why a registry and not only patterns ────────────────────────────────────
 * Pattern matching catches secrets that look like secrets. A registry catches
 * the ones that do not: an encryption key is 32 random bytes in base64 and is
 * indistinguishable from any other base64 blob, and a Client's site password
 * may be "correcthorsebattery". No regex finds those. Exact-value replacement
 * does, and it cannot produce a false negative for a value it holds.
 *
 * Registered values are never read back out. There is no getter — the only
 * thing that can be done with this registry is ask whether a string contains
 * something in it, which is the one operation redaction needs.
 */
const secrets = new Set<string>();

/**
 * Below this length a "secret" is more likely to be a false positive that
 * blanks out half the logs than a real one. An eight-character password is
 * short enough to collide with ordinary words; it is also short enough that the
 * key-name and pattern rules will usually catch it anyway.
 */
const MIN_LENGTH = 8;

export function registerSecret(value: string | undefined | null): void {
  if (!value) return;
  const trimmed = value.trim();
  if (trimmed.length < MIN_LENGTH) return;
  secrets.add(trimmed);
}

/** Replaces every registered value found in `text`. */
export function stripRegisteredSecrets(text: string, replacement: string): string {
  if (secrets.size === 0) return text;

  let result = text;
  for (const secret of secrets) {
    if (result.includes(secret)) result = result.split(secret).join(replacement);
  }
  return result;
}

export function registeredSecretCount(): number {
  return secrets.size;
}

/** Tests only. Registering is one-way in a running process, by design. */
export function clearRegisteredSecrets(): void {
  secrets.clear();
}
