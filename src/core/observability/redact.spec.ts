import { redact, redactString, REDACTED } from './redact';
import {
  clearRegisteredSecrets,
  registerSecret,
  registeredSecretCount,
} from './secret-registry';

describe('redactString', () => {
  afterEach(clearRegisteredSecrets);

  describe('registered literals', () => {
    it('removes a registered value from the middle of a sentence', () => {
      // The case patterns cannot catch: a real password that looks like words.
      registerSecret('correcthorsebatterystaple');
      expect(redactString('login failed for correcthorsebatterystaple on site 4')).toBe(
        `login failed for ${REDACTED} on site 4`,
      );
    });

    it('removes every occurrence, not just the first', () => {
      registerSecret('s3cret-value-here');
      const out = redactString('s3cret-value-here then s3cret-value-here again');
      expect(out).not.toContain('s3cret');
    });

    it('ignores values too short to be distinguishable from words', () => {
      // "abc" registered would blank out a third of the English language.
      registerSecret('abc');
      expect(registeredSecretCount()).toBe(0);
      expect(redactString('abc def')).toBe('abc def');
    });

    it('ignores empty and missing values', () => {
      registerSecret('');
      registerSecret(undefined);
      registerSecret(null);
      expect(registeredSecretCount()).toBe(0);
    });
  });

  describe('shapes', () => {
    it.each([
      ['an OpenAI key', 'using sk-proj-abcdefghijklmnop1234 now'],
      ['an Anthropic key', 'key sk-ant-api03-aaaaaaaaaaaaaaaaaaaa here'],
      ['a Resend key', 're_abcdefghijklmnopqrst failed'],
      ['a bearer header', 'Authorization: Bearer abcdefghijklmnop.qrst'],
      ['a JWT', 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij expired'],
      ['an argon2 hash', 'stored $argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$aGFzaA'],
    ])('redacts %s', (_label, line) => {
      const out = redactString(line);
      expect(out).toContain(REDACTED);
      for (const fragment of ['sk-', 're_', 'eyJ', '$argon2', 'Bearer a']) {
        if (line.includes(fragment)) expect(out).not.toContain(fragment);
      }
    });

    it('redacts the password inside a connection string, keeping the rest', () => {
      const out = redactString('postgres://app:hunter2hunter2@db.internal:5432/jaa');
      expect(out).not.toContain('hunter2');
      // The host and database are what make the error diagnosable.
      expect(out).toContain('db.internal:5432/jaa');
      expect(out).toContain('postgres://app:');
    });

    it('leaves ordinary text alone', () => {
      const line = 'Applied to Operations Lead at Sky Capital — fit 7.4';
      expect(redactString(line)).toBe(line);
    });
  });

  it('truncates a string long enough to be a payload', () => {
    expect(redactString('x'.repeat(10_000))).toContain('[truncated]');
  });
});

describe('redact', () => {
  afterEach(clearRegisteredSecrets);

  it('redacts by key name whatever the value', () => {
    expect(
      redact({ email: 'a@b.co', password: 'anything at all', apiKey: 'x' }),
    ).toEqual({ email: 'a@b.co', password: REDACTED, apiKey: REDACTED });
  });

  it.each([
    'password',
    'passphrase',
    'accessToken',
    'refresh_token',
    'api_key',
    'ANTHROPIC_API_KEY',
    'authorization',
    'cookie',
    'ciphertext',
    'encryptionKey',
    'privateKey',
    'signature',
  ])('treats %s as sensitive', (key) => {
    expect((redact({ [key]: 'value' }) as Record<string, unknown>)[key]).toBe(REDACTED);
  });

  it.each(['tokenCount', 'inputTokens', 'credentialId', 'keyVersion', 'actorType'])(
    'keeps %s, which is what makes an incident diagnosable',
    (key) => {
      expect((redact({ [key]: 'value' }) as Record<string, unknown>)[key]).toBe('value');
    },
  );

  it('recurses into nested objects and arrays', () => {
    const out = redact({
      request: { body: { sites: [{ url: 'x.com', password: 'p' }] } },
    });
    expect(JSON.stringify(out)).not.toContain('"p"');
    expect(JSON.stringify(out)).toContain('x.com');
  });

  it('redacts an Error’s message, stack and cause', () => {
    registerSecret('correcthorsebatterystaple');
    const cause = new Error('body: correcthorsebatterystaple');
    const error = new Error('failed for correcthorsebatterystaple', { cause });

    const out = JSON.stringify(redact(error));
    expect(out).not.toContain('correcthorse');
    expect(out).toContain('failed for');
  });

  it('never mutates what it was given', () => {
    // A logger that edits the object it was asked to log has changed the
    // program, and the bug that causes is close to undebuggable.
    const original = { password: 'secret-value-here', nested: { token: 'abc12345' } };
    redact(original);
    expect(original.password).toBe('secret-value-here');
    expect(original.nested.token).toBe('abc12345');
  });

  it('stops at a depth limit rather than walking a cyclic graph forever', () => {
    const deep: Record<string, unknown> = {};
    let node = deep;
    for (let i = 0; i < 20; i++) {
      node.next = {};
      node = node.next as Record<string, unknown>;
    }
    expect(JSON.stringify(redact(deep))).toContain('[depth limit]');
  });

  it('does not stringify a function’s source', () => {
    expect(redact({ fn: () => 'correcthorsebatterystaple' })).toEqual({ fn: '[function]' });
  });

  it('passes numbers and booleans through untouched', () => {
    expect(redact({ score: 7.4, applied: true })).toEqual({ score: 7.4, applied: true });
  });
});
