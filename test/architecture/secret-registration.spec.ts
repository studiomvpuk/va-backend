import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every secret in the environment schema is handed to the redactor at boot.
 *
 * The registry catches secrets no pattern can — an encryption key is
 * indistinguishable from any other base64 — but only the values it was given.
 * A variable added to the schema and not to `registerSecrets` is a secret the
 * redactor cannot see, and nothing at runtime would ever say so.
 *
 * So the two lists are checked against each other. Adding a secret to the env
 * and forgetting the registry fails CI; adding a non-secret and forgetting it
 * does nothing, because the allowlist below is what decides which is which.
 */
const SRC = join(__dirname, '../../src');

/**
 * Environment variables that are NOT secrets, with the reason each is safe.
 *
 * This list is the reviewable part: adding a name here is a claim that the
 * value is not sensitive, and it is short enough that the claim gets read.
 */
const NOT_SECRET: Record<string, string> = {
  NODE_ENV: 'an enum',
  PORT: 'a number',
  WEB_ORIGIN: 'a public origin, sent in every CORS header',
  COOKIE_SAMESITE: 'an enum',
  COOKIE_DOMAIN: 'a public hostname',
  EMAIL_FROM: 'a public sender address, printed on every email',
  SUPABASE_URL: 'a public project URL; the service key beside it is the secret',
  ACCESS_TOKEN_TTL_SECONDS: 'a number',
  REFRESH_TOKEN_TTL_DAYS: 'a number',
  ENCRYPTION_KEY_VERSION: 'a version number, stamped on records in plain sight',
  ENCRYPTION_KEY_PREVIOUS_VERSION: 'a version number',
  WHATSAPP_PHONE_NUMBER_ID: 'an account identifier, not a credential',
  WHATSAPP_TEMPLATE_NAME: 'the name of an approved message template',
};

describe('secret registration', () => {
  const schema = readFileSync(join(SRC, 'core/config/env.schema.ts'), 'utf8');
  const main = readFileSync(join(SRC, 'main.ts'), 'utf8');

  // Not `z\.` — ENCRYPTION_KEY is declared with a custom base64Bytes(32)
  // validator, and a regex that assumed the zod prefix silently skipped the
  // most sensitive variable in the file. Match the key, not the value's shape.
  const declared = [...schema.matchAll(/^ {2}([A-Z][A-Z0-9_]+):\s*\S/gm)].map((m) => m[1]);
  const registered = [...main.matchAll(/registerSecret\(config\.get\('([A-Z0-9_]+)'\)\)/g)].map(
    (m) => m[1],
  );

  it('finds the environment variables', () => {
    expect(declared.length).toBeGreaterThan(8);
  });

  it('registers every variable not explicitly declared non-secret', () => {
    const missing = declared.filter(
      (name) => !(name in NOT_SECRET) && !registered.includes(name),
    );

    // Jest shows the array, and the array IS the instruction: every name in it
    // needs a registerSecret() line in main.ts, or an entry in NOT_SECRET here
    // with the reason it is safe.
    expect({ unregistered: missing }).toEqual({ unregistered: [] });
  });

  it('does not register anything that is not in the schema', () => {
    // A stale entry is harmless but it means the list has stopped being read.
    expect(registered.filter((name) => !declared.includes(name))).toEqual([]);
  });

  it('registers secrets before the logger is installed', () => {
    // The order is the whole guarantee. Buffered boot logs — the ones most
    // likely to contain a connection string — flush when useLogger is called.
    expect(main.indexOf('registerSecrets(config)')).toBeGreaterThan(0);
    expect(main.indexOf('registerSecrets(config)')).toBeLessThan(
      main.indexOf('app.useLogger'),
    );
    expect(main).toContain('bufferLogs: true');
  });

  it('installs the redacting logger application-wide', () => {
    // Not a provider a call site can choose to use. §7.3: "enforced by a
    // formatter, not by developers remembering."
    expect(main).toMatch(/app\.useLogger\(redacting\)/);
  });
});
