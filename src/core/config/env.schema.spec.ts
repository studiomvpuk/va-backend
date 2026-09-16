import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import { validateEnv } from './env.schema';

const valid = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  DIRECT_URL: 'postgresql://u:p@localhost:5432/db',
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  JWT_SECRET: 'x'.repeat(32),
  JWT_REFRESH_SECRET: 'y'.repeat(32),
  WEB_ORIGIN: 'http://localhost:3000',
};

describe('env validation', () => {
  it('accepts a complete environment', () => {
    expect(() => validateEnv(valid)).not.toThrow();
  });

  it('refuses to boot without an encryption key', () => {
    const { ENCRYPTION_KEY: _omitted, ...rest } = valid;
    expect(() => validateEnv(rest)).toThrow(/ENCRYPTION_KEY/);
  });

  it('rejects an encryption key of the wrong length', () => {
    expect(() =>
      validateEnv({ ...valid, ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') }),
    ).toThrow(/32 bytes/);
  });

  it('rejects a wildcard CORS origin', () => {
    expect(() => validateEnv({ ...valid, WEB_ORIGIN: '*' })).toThrow();
  });

  // ── Blank means unset ──────────────────────────────────────────────────────
  //
  // These exist because the documented first step — copy .env.example, fill in
  // the secrets — used to fail with seven errors, five of them for optional
  // variables the operator had never touched. dotenv turns `REDIS_URL=` into an
  // empty string, which `.optional()` treats as present.

  it('treats a blank optional variable as unset, not as an invalid value', () => {
    expect(() =>
      validateEnv({
        ...valid,
        REDIS_URL: '',
        SUPABASE_URL: '',
        ANTHROPIC_API_KEY: '',
        EMAIL_FROM: '',
        COOKIE_DOMAIN: '',
      }),
    ).not.toThrow();
  });

  it('falls back to the default when a variable with one is blank', () => {
    const env = validateEnv({
      ...valid,
      PORT: '',
      ACCESS_TOKEN_TTL_SECONDS: '',
      COOKIE_SAMESITE: '',
      ENCRYPTION_KEY_VERSION: '',
    });
    expect(env.PORT).toBe(4000);
    expect(env.ACCESS_TOKEN_TTL_SECONDS).toBe(900);
    expect(env.COOKIE_SAMESITE).toBe('lax');
    expect(env.ENCRYPTION_KEY_VERSION).toBe(1);
  });

  it('does not read two unset rotation keys as a rotation clash', () => {
    // Both blank meant `'' === ''`, which reported "ENCRYPTION_KEY_PREVIOUS is
    // the same value as ENCRYPTION_KEY" to someone rotating nothing.
    expect(() =>
      validateEnv({
        ...valid,
        ENCRYPTION_KEY_PREVIOUS: '',
        ENCRYPTION_KEY_PREVIOUS_VERSION: '',
      }),
    ).not.toThrow();
  });

  it('still catches a real rotation clash', () => {
    expect(() =>
      validateEnv({
        ...valid,
        ENCRYPTION_KEY_VERSION: '2',
        ENCRYPTION_KEY_PREVIOUS: valid.ENCRYPTION_KEY,
        ENCRYPTION_KEY_PREVIOUS_VERSION: '1',
      }),
    ).toThrow(/same value as ENCRYPTION_KEY/);
  });

  it('a blank REQUIRED variable still fails — blankness is not a free pass', () => {
    expect(() => validateEnv({ ...valid, ENCRYPTION_KEY: '' })).toThrow(/ENCRYPTION_KEY/);
    expect(() => validateEnv({ ...valid, DATABASE_URL: '' })).toThrow(/DATABASE_URL/);
  });

  it('names a blank required key once, not twice', () => {
    const message = (() => {
      try {
        validateEnv({ ...valid, ENCRYPTION_KEY: '' });
        return '';
      } catch (e) {
        return (e as Error).message;
      }
    })();
    // "required" and "must be 32 bytes" are one problem with one fix.
    expect(message.match(/ENCRYPTION_KEY:/g)?.length).toBe(1);
  });

  it('.env.example passes validation once the three secrets are filled in', () => {
    // The contract the README makes with a new contributor, asserted rather
    // than assumed. If a future optional variable is added to the example with
    // a blank value and no unsetIfBlank wrapper, this fails.
    const example = parseDotenv(
      readFileSync(join(__dirname, '../../../.env.example'), 'utf8'),
    );
    expect(() =>
      validateEnv({
        ...example,
        NODE_ENV: 'test',
        ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
        JWT_SECRET: 'a'.repeat(32),
        JWT_REFRESH_SECRET: 'b'.repeat(32),
      }),
    ).not.toThrow();
  });

  it('reports every problem at once rather than one per restart', () => {
    const message = (() => {
      try {
        validateEnv({ NODE_ENV: 'test' });
        return '';
      } catch (e) {
        return (e as Error).message;
      }
    })();
    expect(message).toMatch(/DATABASE_URL/);
    expect(message).toMatch(/ENCRYPTION_KEY/);
    expect(message).toMatch(/JWT_SECRET/);
  });
});
