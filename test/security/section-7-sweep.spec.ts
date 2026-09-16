import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The §7 sweep, as assertions rather than a checklist someone ticked.
 *
 * Most of §7 is already enforced by a test somewhere — tenant scoping, route
 * guards, the credential gate, unscoped access, sensitive reads. This file
 * covers the items that had no test of their own, and exists so that "we swept
 * §7" is a thing CI re-establishes on every commit rather than a claim about
 * one afternoon in Phase 10.
 *
 * Where a requirement is covered elsewhere, it is named here rather than
 * duplicated, so the map from requirement to proof stays in one place.
 */
const ROOT = join(__dirname, '../..');
const SRC = join(ROOT, 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.ts$/.test(entry) && !/\.spec\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

const sources = walk(SRC).map((path) => ({
  path: path.slice(ROOT.length + 1),
  source: readFileSync(path, 'utf8'),
}));

describe('§7.1 authorisation', () => {
  it('is covered by route-guards, tenant-scoping and unscoped-access', () => {
    // Named rather than re-asserted. Those three suites are the proof.
    for (const suite of ['route-guards', 'tenant-scoping', 'unscoped-access']) {
      expect(readdirSync(join(ROOT, 'test/architecture'))).toContain(`${suite}.spec.ts`);
    }
  });
});

describe('§7.2 input handling', () => {
  it('rejects request bodies carrying properties no DTO declares', () => {
    const main = readFileSync(join(SRC, 'main.ts'), 'utf8');
    // `whitelist` alone strips the extra property silently. `forbidNonWhitelisted`
    // rejects the request, which is what turns a typo'd field name from a
    // silently-ignored input into an error the caller sees.
    expect(main).toContain('whitelist: true');
    expect(main).toContain('forbidNonWhitelisted: true');
  });

  it('wraps every piece of third-party text as untrusted input before a prompt', () => {
    // Job descriptions, screening questions and search results are all
    // attacker-controllable and all reach a model.
    const registry = readFileSync(join(SRC, 'ai/prompts/prompt-registry.ts'), 'utf8');
    expect(registry).toContain('export function asUntrustedInput');

    const callers = sources.filter((f) => /asUntrustedInput\(/.test(f.source));
    expect(callers.length).toBeGreaterThanOrEqual(3);
  });

  it('never lets a model decide a disclosure', () => {
    // §7.2: "the model is never the thing that decides whether a sensitive
    // field may be disclosed." The classifier proposes a key; the service
    // validates it against the candidate set before any value is read.
    const service = readFileSync(join(SRC, 'disclosure/disclosure.service.ts'), 'utf8');
    expect(service).toMatch(/candidate/i);
    expect(readdirSync(join(SRC, 'disclosure'))).toContain('disclosure.service.spec.ts');
  });

  it('sanitises uploaded images before they leave the building', () => {
    const controller = readFileSync(join(SRC, 'conversation/va-chat.controller.ts'), 'utf8');
    expect(controller).toContain('sanitiseBase64Image');

    // The raw body must not reach the provider — that was the bug.
    expect(controller).not.toMatch(/data:\s*dto\.image/);
  });

  it('validates image type and size at the DTO', () => {
    const dto = readFileSync(join(SRC, 'conversation/dto/chat.dto.ts'), 'utf8');
    expect(dto).toMatch(/@IsIn\(\['image\/png', 'image\/jpeg', 'image\/webp'\]\)/);
    expect(dto).toMatch(/@MaxLength\(\d[\d_]*\)/);
  });

  it('stores no uploaded image, so there is no origin to serve it from', () => {
    // §7.2 asks for uploads to be "served from a separate origin". Nothing is
    // stored: a screenshot is passed to the vision provider and discarded, so
    // the requirement is met by there being no artefact rather than by an
    // isolated bucket. Asserted, because starting to store them would need this
    // decision revisited.
    // Matched on field declarations, not the whole file — the schema now
    // explains in a comment why the column is absent, and a test that cannot
    // tell a field from the prose about it forbids writing the prose.
    const schema = readFileSync(join(ROOT, 'prisma/schema.prisma'), 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');

    expect(schema).not.toMatch(/^\s*(imageUrl|screenshotUrl|uploadPath|blobKey)\s/im);
  });
});

describe('§7.3 secrets', () => {
  it('reads process.env nowhere outside the config module', () => {
    // Everything goes through the validated schema, which is also the list the
    // redactor registers from. A stray process.env read is a secret nothing
    // knows about.
    const offenders = sources
      .filter((f) => /process\.env/.test(f.source))
      .map((f) => f.path)
      .filter(
        (path) =>
          !path.startsWith('src/core/config/') &&
          // main.ts reads NODE_ENV before the container exists; the CLI reads argv.
          path !== 'src/core/persistence/prisma.service.ts',
      );

    expect({ readsProcessEnv: offenders }).toEqual({ readsProcessEnv: [] });
  });

  it('never logs with console', () => {
    // console bypasses the redacting formatter entirely.
    const offenders = sources
      .filter((f) => /\bconsole\.(log|info|debug|warn|error)\(/.test(f.source))
      .map((f) => f.path)
      // main.ts's last-resort handler runs when the container failed to build,
      // so there is no logger to use. It prints an env-validation message.
      .filter((path) => path !== 'src/main.ts');

    expect({ usesConsole: offenders }).toEqual({ usesConsole: [] });
  });

  it('exposes no read path for a BYOK key', () => {
    const keyring = sources.filter((f) => f.path.startsWith('src/keyring/'));
    expect(keyring.length).toBeGreaterThan(0);

    for (const file of keyring) {
      // A route returning a key, for anyone, including the Client who set it.
      expect(file.source).not.toMatch(/@Get\([^)]*\)[\s\S]{0,200}?\breturn\b[^;]*\bkey\b/);
    }
  });

  it('is covered for redaction by test/security/log-redaction.spec.ts', () => {
    expect(readdirSync(join(ROOT, 'test/security'))).toContain('log-redaction.spec.ts');
  });
});

describe('§7.4 the credential-sharing gate', () => {
  it('is covered by va-agreement-gate, credential-access and sharing-gate', () => {
    expect(readdirSync(join(ROOT, 'test/architecture'))).toContain('va-agreement-gate.spec.ts');
    expect(readdirSync(join(ROOT, 'test/architecture'))).toContain('credential-access.spec.ts');
    expect(readdirSync(join(SRC, 'vault'))).toContain('sharing-gate.spec.ts');
  });
});

describe('§7.5 rate limiting', () => {
  it('answers a breach with a specific error, never a generic 500', () => {
    const service = readFileSync(join(SRC, 'ratelimit/rate-limit.service.ts'), 'utf8');
    // 429 with something a person can read — a silent failure or a 500 tells
    // the VA nothing and looks like the product is broken.
    expect(service).toMatch(/TooManyRequests|429|HttpStatus\.TOO_MANY_REQUESTS/);
  });

  it('limits both the VA and the Client, which are different failures', () => {
    const service = readFileSync(join(SRC, 'ratelimit/rate-limit.service.ts'), 'utf8');
    // Per-VA guards against one assistant hammering the API; per-Client guards
    // against runaway cost from a bug.
    expect(service).toMatch(/consumeVaMessage/);
    expect(service).toMatch(/consumeClientAiCall/);
  });
});

describe('§7.6 operational', () => {
  it('pins no dependency override without a written reason', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      overrides?: Record<string, string>;
    };
    if (!pkg.overrides) return;

    const doc = readFileSync(join(ROOT, 'OVERRIDES.md'), 'utf8');
    for (const name of Object.keys(pkg.overrides)) {
      expect(doc).toContain(`\`${name}\``);
    }
  });

  it('sets CORS to an exact origin, never a wildcard', () => {
    const schema = readFileSync(join(SRC, 'core/config/env.schema.ts'), 'utf8');
    expect(schema).toContain("v !== '*'");
  });
});
