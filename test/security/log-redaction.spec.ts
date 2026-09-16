import { RedactingLogger } from '../../src/core/observability/redacting.logger';
import {
  clearRegisteredSecrets,
  registerSecret,
} from '../../src/core/observability/secret-registry';
import { scrubEvent } from '../../src/core/observability/sentry-scrubber';

/**
 * PRD Phase 10 acceptance, verbatim:
 *
 *   "No credential, API key or sensitive value appears in any log, error report
 *    or stack trace — verified by a test that logs a seeded secret and greps
 *    the sink."
 *
 * So: seed secrets, push them through the real logger in every shape a real
 * call site produces, capture what actually reaches stdout, and grep it. The
 * assertion is on the bytes written, not on the redaction function — a correct
 * redactor wired up wrongly fails this and passes a unit test.
 */

/** One of each kind this product actually holds. */
const SEEDED = {
  encryptionKey: 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZg==',
  anthropicKey: 'sk-ant-api03-SEEDEDSEEDEDSEEDEDSEEDED',
  sitePassword: 'correcthorsebatterystaple',
  sensitiveValue: '14 Wilmslow Road, Manchester M14 5TQ',
  refreshToken: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ2YS0xIn0.c2lnbmF0dXJl',
  databaseUrl: 'postgres://app:Pa55word!Long@db.internal:5432/understudy',
};

describe('nothing secret reaches the log sink', () => {
  let sink: string[];
  let spies: jest.SpyInstance[];

  beforeEach(() => {
    sink = [];
    // The sink is process.stdout/stderr — where ConsoleLogger actually writes.
    // Spying on `console.log` would test a layer the logger does not use.
    const capture = (chunk: unknown): boolean => {
      sink.push(String(chunk));
      return true;
    };
    spies = [
      jest.spyOn(process.stdout, 'write').mockImplementation(capture),
      jest.spyOn(process.stderr, 'write').mockImplementation(capture),
    ];

    for (const value of Object.values(SEEDED)) registerSecret(value);
    // The connection string's password is registered only as part of the whole
    // URL, so the bare password exercises the shape rule rather than the registry.
    registerSecret(SEEDED.databaseUrl);
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    clearRegisteredSecrets();
  });

  function grep(): string {
    return sink.join('\n');
  }

  function expectNothingLeaked(): void {
    const written = grep();
    expect(written.length).toBeGreaterThan(0);

    // Reported as a list rather than one assertion per value, so a failure
    // names every secret that leaked instead of stopping at the first.
    const leaked = Object.entries(SEEDED)
      .filter(([, value]) => written.includes(value))
      .map(([name]) => name);

    // Distinctive fragments too, in case something truncated a secret and left
    // the useful half.
    const fragments = ['sk-ant-api03', 'correcthorse', 'Wilmslow', 'Pa55word', 'eyJhbGciOi'].filter(
      (fragment) => written.includes(fragment),
    );

    expect({ leaked, fragments }).toEqual({ leaked: [], fragments: [] });
  }

  it('redacts a secret passed as the message', () => {
    const logger = new RedactingLogger('test');
    logger.log(`connecting with ${SEEDED.anthropicKey}`);
    logger.warn(`password is ${SEEDED.sitePassword}`);
    expectNothingLeaked();
  });

  it('redacts a secret nested in an object', () => {
    const logger = new RedactingLogger('test');
    logger.log({
      event: 'provider.call',
      config: { apiKey: SEEDED.anthropicKey, url: 'https://api.anthropic.com' },
      client: { address: SEEDED.sensitiveValue },
    });
    expectNothingLeaked();
  });

  it('redacts a secret carried in an Error and its stack', () => {
    const logger = new RedactingLogger('test');
    const error = new Error(`decrypt failed for ${SEEDED.encryptionKey}`);
    logger.error(error);
    logger.error('while revealing a credential', error.stack);
    expectNothingLeaked();
  });

  it('redacts a secret in an Error’s cause, three levels down', () => {
    // How a provider response body — the request that carried the key — ends
    // up in a log without anyone deciding to put it there.
    const logger = new RedactingLogger('test');
    const root = new Error(`request body: {"password":"${SEEDED.sitePassword}"}`);
    const middle = new Error('provider call failed', { cause: root });
    logger.error(new Error('drafting failed', { cause: middle }));
    expectNothingLeaked();
  });

  it('redacts a connection string with credentials in it', () => {
    const logger = new RedactingLogger('test');
    logger.error(`could not connect: ${SEEDED.databaseUrl}`);
    expectNothingLeaked();
  });

  it('redacts a refresh token in a request log', () => {
    const logger = new RedactingLogger('test');
    logger.log({
      method: 'POST',
      path: '/v1/auth/refresh',
      headers: { cookie: `understudy_refresh=${SEEDED.refreshToken}`, 'user-agent': 'curl/8' },
    });
    expectNothingLeaked();
  });

  it('still writes something useful', () => {
    // A redactor that blanks the whole line passes every assertion above and is
    // worse than no logging at all.
    const logger = new RedactingLogger('test');
    logger.log({
      event: 'credential.reveal',
      credentialId: 'cred-abc123',
      siteHost: 'linkedin.com',
      vaId: 'va-7',
      password: SEEDED.sitePassword,
    });

    const written = grep();
    expect(written).toContain('cred-abc123');
    expect(written).toContain('linkedin.com');
    expect(written).toContain('va-7');
    expectNothingLeaked();
  });
});

describe('nothing secret reaches the error reporter', () => {
  beforeEach(() => {
    registerSecret(SEEDED.sitePassword);
    registerSecret(SEEDED.encryptionKey);
  });
  afterEach(clearRegisteredSecrets);

  it('scrubs headers, cookies, body, extras and frame locals', () => {
    const scrubbed = scrubEvent({
      message: `failed with ${SEEDED.encryptionKey}`,
      request: {
        url: `https://api.example.com/v1/x?token=${SEEDED.refreshToken}`,
        headers: { authorization: `Bearer ${SEEDED.refreshToken}`, 'x-request-id': 'req-1' },
        cookies: { understudy_refresh: SEEDED.refreshToken },
        data: { password: SEEDED.sitePassword },
      },
      extra: { decrypted: SEEDED.sitePassword },
      user: { id: 'client-1', email: 'a@b.co', passwordHash: 'should not travel' },
      exception: {
        values: [
          {
            value: `boom ${SEEDED.sitePassword}`,
            stacktrace: {
              // The decrypted password is a local in the frame that decrypted it.
              frames: [{ filename: 'cipher.ts', vars: { plaintext: SEEDED.sitePassword } }],
            },
          },
        ],
      },
      breadcrumbs: [{ message: `used ${SEEDED.sitePassword}`, data: { apiKey: 'sk-live-xyz' } }],
    });

    const serialised = JSON.stringify(scrubbed);
    for (const value of [SEEDED.sitePassword, SEEDED.encryptionKey, SEEDED.refreshToken]) {
      expect(serialised).not.toContain(value);
    }
    expect(serialised).not.toContain('should not travel');

    // Still diagnosable.
    expect(serialised).toContain('req-1');
    expect(serialised).toContain('cipher.ts');
    expect(serialised).toContain('client-1');
  });

  it('sends no cookies at all', () => {
    // The refresh cookie is a live credential, not a hint of one.
    const scrubbed = scrubEvent({ request: { cookies: { understudy_refresh: 'anything' } } });
    expect(scrubbed.request?.cookies).toEqual({});
  });
});
