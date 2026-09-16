import { z } from 'zod';

/**
 * The environment contract.
 *
 * Every value the API needs is declared here with the validation it must pass.
 * There are no defaults for secrets — a missing ENCRYPTION_KEY must stop the
 * process at boot, loudly, rather than surface at 2am as a null dereference
 * inside the vault.
 */

const base64Bytes = (n: number) =>
  z
    .string()
    .min(1, 'required — this has no default and the API will not start without it')
    .refine(
      (v) => {
        // A blank value has already failed min(1). Reporting "must be 32 bytes"
        // on top of "required" is two lines for one problem, and the operator
        // has to read both to learn there is only one thing to do.
        if (v === '') return true;
        try {
          return Buffer.from(v, 'base64').length === n;
        } catch {
          return false;
        }
      },
      { message: `must be ${n} bytes encoded as base64 (openssl rand -base64 ${n})` },
    );

/**
 * Blank means unset.
 *
 * dotenv hands a blank assignment (`REDIS_URL=`) to the process as an empty
 * string, not as an absent variable, and Zod's `.optional()` only skips
 * `undefined`. So every variable left blank in a .env arrives as a *present,
 * invalid* value — and `.env.example` blanks every optional variable by design,
 * which made the documented first step ("copy the example, fill in the secrets")
 * produce a wall of errors for settings nobody had touched.
 *
 * Treating blank as unset is also the honest reading: a variable set to nothing
 * is a variable the operator did not set. This wrapper is applied to every
 * optional field and every field with a default. Required fields are left
 * alone — those still fail loudly when blank, which is the entire point of them.
 */
const unsetIfBlank = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema);

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'staging', 'production', 'test']),
  PORT: unsetIfBlank(z.coerce.number().int().positive().default(4000)),

  DATABASE_URL: z.string().url(),
  DIRECT_URL: z.string().url(),

  /*
   * AES-256-GCM master key. Derives per-record data keys (PRD §4).
   *
   * ── Rotation needs three variables, not one ────────────────────────────────
   * `keyVersion` on a record used to select only the HKDF info string, with one
   * master key behind every version. That is not rotation: if the master key
   * leaks, every version derived from it leaks with it, and re-encrypting from
   * v1 to v2 protects nothing.
   *
   * A real rotation introduces a NEW master key and keeps the old one readable
   * while records move across. So:
   *
   *   ENCRYPTION_KEY           the key new records are written with
   *   ENCRYPTION_KEY_VERSION   its version number, stamped on those records
   *   ENCRYPTION_KEY_PREVIOUS  the retiring key, still needed to read old rows
   *
   * The runbook is in docs/RUNBOOK-key-rotation.md; `npm run rotate-keys` does
   * the re-encryption and reports when the previous key can be removed.
   */
  ENCRYPTION_KEY: base64Bytes(32),
  ENCRYPTION_KEY_VERSION: unsetIfBlank(z.coerce.number().int().positive().default(1)),
  ENCRYPTION_KEY_PREVIOUS: unsetIfBlank(base64Bytes(32).optional()),
  ENCRYPTION_KEY_PREVIOUS_VERSION: unsetIfBlank(
    z.coerce.number().int().positive().optional(),
  ),

  JWT_SECRET: z.string().min(32, 'use at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'use at least 32 characters'),

  /* Seconds, not a duration string: '15m' has to be parsed by something,
     and a number is unambiguous to both the JWT library and a reader. */
  ACCESS_TOKEN_TTL_SECONDS: unsetIfBlank(z.coerce.number().int().positive().default(900)),
  REFRESH_TOKEN_TTL_DAYS: unsetIfBlank(z.coerce.number().int().positive().default(7)),

  /*
   * The refresh token travels in an httpOnly cookie. SameSite=Lax only sends it
   * when the API and the web app share a registrable domain, so production
   * should run the API on a subdomain of the web app (api.example.com against
   * app.example.com). Preview deployments on different domains need
   * SameSite=None, which requires Secure and is strictly weaker — hence the
   * explicit setting rather than a silent fallback.
   */
  COOKIE_SAMESITE: unsetIfBlank(z.enum(['lax', 'strict', 'none']).default('lax')),
  COOKIE_DOMAIN: unsetIfBlank(z.string().optional()),

  // CORS is an exact allowlist. "*" is rejected rather than merely discouraged.
  WEB_ORIGIN: z
    .string()
    .url()
    .refine((v) => v !== '*', { message: 'must be an exact origin, never "*"' }),

  // Optional in development; required before the phases that consume them.
  ANTHROPIC_API_KEY: unsetIfBlank(z.string().optional()),
  OPENAI_API_KEY: unsetIfBlank(z.string().optional()),
  RESEND_API_KEY: unsetIfBlank(z.string().optional()),
  // Without a verified sender address Resend rejects every send, so the email
  // channel refuses to register at all rather than failing once per
  // notification. Absent key or absent from-address means in-app only.
  EMAIL_FROM: unsetIfBlank(z.string().optional()),
  REDIS_URL: unsetIfBlank(z.string().url().optional()),
  // Company background research. Absent means prep documents are still
  // generated — from the posting and the Client's own profile — with the
  // background section honestly empty rather than invented.
  BRAVE_SEARCH_API_KEY: unsetIfBlank(z.string().optional()),
  // WhatsApp Business. All three or the channel does not register: a token
  // with no phone number id sends nothing, and a send needs an approved
  // template name.
  WHATSAPP_ACCESS_TOKEN: unsetIfBlank(z.string().optional()),
  WHATSAPP_PHONE_NUMBER_ID: unsetIfBlank(z.string().optional()),
  WHATSAPP_TEMPLATE_NAME: unsetIfBlank(z.string().optional()),

  SUPABASE_URL: unsetIfBlank(z.string().url().optional()),
  SUPABASE_SERVICE_KEY: unsetIfBlank(z.string().optional()),
})
  .refine(
    (env) =>
      (env.ENCRYPTION_KEY_PREVIOUS === undefined) ===
      (env.ENCRYPTION_KEY_PREVIOUS_VERSION === undefined),
    {
      message:
        'ENCRYPTION_KEY_PREVIOUS and ENCRYPTION_KEY_PREVIOUS_VERSION must be set together — ' +
        'a key with no version cannot be matched to any record, and a version with no key ' +
        'silently fails to decrypt the rows that need it',
      path: ['ENCRYPTION_KEY_PREVIOUS'],
    },
  )
  .refine(
    (env) =>
      env.ENCRYPTION_KEY_PREVIOUS_VERSION === undefined ||
      env.ENCRYPTION_KEY_PREVIOUS_VERSION < env.ENCRYPTION_KEY_VERSION,
    {
      message:
        'ENCRYPTION_KEY_PREVIOUS_VERSION must be lower than ENCRYPTION_KEY_VERSION — ' +
        'if they are equal the two keys claim the same records and decryption is a coin toss',
      path: ['ENCRYPTION_KEY_PREVIOUS_VERSION'],
    },
  )
  .refine(
    // Only meaningful when a previous key is actually configured. Comparing two
    // absent values found them equal and reported a rotation clash to operators
    // who were not rotating anything.
    (env) =>
      env.ENCRYPTION_KEY_PREVIOUS === undefined ||
      env.ENCRYPTION_KEY_PREVIOUS !== env.ENCRYPTION_KEY,
    {
      message:
        'ENCRYPTION_KEY_PREVIOUS is the same value as ENCRYPTION_KEY — the rotation would ' +
        're-encrypt every record under the key it is supposed to be retiring',
      path: ['ENCRYPTION_KEY_PREVIOUS'],
    },
  );

export type Env = z.infer<typeof envSchema>;

/**
 * Validates and returns the environment, or throws with every problem listed at
 * once. Reporting all failures together matters: fixing one variable per restart
 * is how a five-minute setup becomes an hour.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (result.success) return result.data;

  const problems = result.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');

  throw new Error(
    `\nEnvironment validation failed. The API will not start.\n\n${problems}\n\n` +
      `See .env.example for the full contract.\n`,
  );
}
