import { writeSync } from 'node:fs';

import { z } from 'zod';

/**
 * The single source of truth for this application's configuration.
 *
 * This is the only module permitted to read `process.env` — enforced by the
 * `no-restricted-properties` rule in the shared ESLint config. Everything else
 * receives the parsed, typed result through the ENV injection token.
 */

const nonEmpty = z.string().trim().min(1);

const httpOrigin = z
  .url()
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        return (
          (url.protocol === 'http:' || url.protocol === 'https:') &&
          url.pathname === '/' &&
          url.search === '' &&
          url.hash === '' &&
          url.username === '' &&
          url.password === ''
        );
      } catch {
        return false;
      }
    },
    { message: 'must be a bare HTTP(S) origin, for example https://app.example.com' },
  )
  .transform((value) => new URL(value).origin);

/** Accepts the strings an env file can hold and yields a real boolean. */
const booleanFromString = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

/** Values that exist in .env.example purely as placeholders. */
const PLACEHOLDER_PATTERN = /replace_me/i;

const isPlaceholder = (value: string | undefined): boolean =>
  value === undefined || value.trim() === '' || PLACEHOLDER_PATTERN.test(value);

export const envSchema = z
  .object({
    // ── runtime ──────────────────────────────────────────────────────────────
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_ROLE: z.enum(['api', 'worker']).default('api'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    /**
     * The share of `GET /public/availability` request lines that are written.
     *
     * That one endpoint is hit on every date change a browsing customer makes, and
     * nothing else comes close to its volume. Defaulting to 1 means a deployment
     * that has not thought about this is not quietly dropping lines; turning it
     * down is a decision an operator takes when the log bill says so.
     */
    LOG_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(1),

    // ── data stores ──────────────────────────────────────────────────────────
    DATABASE_URL: nonEmpty.refine(
      (value) => value.startsWith('postgresql://') || value.startsWith('postgres://'),
      { message: 'DATABASE_URL must be a postgresql:// connection string' },
    ),
    DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),
    REDIS_URL: nonEmpty.refine(
      (value) => value.startsWith('redis://') || value.startsWith('rediss://'),
      { message: 'REDIS_URL must be a redis:// connection string' },
    ),
    /**
     * Namespace for every BullMQ key, so one Redis can serve two environments —
     * and so the integration suite's queue reset provably cannot reach the
     * queues an application is using. The API and its workers must agree on this
     * value; if they disagree the workers consume nothing, silently.
     */
    REDIS_QUEUE_PREFIX: nonEmpty
      .regex(/^[a-z0-9:_-]+$/i, 'REDIS_QUEUE_PREFIX must be a simple key-safe token')
      .default('bull'),

    // ── tenancy ──────────────────────────────────────────────────────────────
    DEFAULT_ORGANIZATION_SLUG: nonEmpty,

    // ── web origins ──────────────────────────────────────────────────────────
    PUBLIC_WEB_ORIGIN: httpOrigin,
    PUBLIC_API_ORIGIN: httpOrigin,

    // ── payments ─────────────────────────────────────────────────────────────
    PAYMENT_PROVIDER: z.enum(['fake', 'stripe']).default('fake'),
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),

    // ── email ────────────────────────────────────────────────────────────────
    EMAIL_PROVIDER: z.enum(['fake', 'resend']).default('fake'),
    EMAIL_FROM_ADDRESS: z.email(),
    EMAIL_FROM_NAME: nonEmpty,
    RESEND_API_KEY: z.string().optional(),
    RESEND_WEBHOOK_SECRET: z.string().optional(),

    // ── sms ──────────────────────────────────────────────────────────────────
    SMS_PROVIDER: z.enum(['fake', 'twilio']).default('fake'),
    TWILIO_ACCOUNT_SID: z.string().optional(),
    TWILIO_AUTH_TOKEN: z.string().optional(),
    TWILIO_FROM_NUMBER: z.string().optional(),
    TWILIO_STATUS_CALLBACK_URL: z.string().optional(),

    // ── security ─────────────────────────────────────────────────────────────
    SESSION_COOKIE_NAME: nonEmpty.default('sf_office_session'),
    SESSION_IDLE_TTL_MINUTES: z.coerce.number().int().min(5).max(10080).default(720),
    SESSION_ABSOLUTE_TTL_MINUTES: z.coerce.number().int().min(60).max(43200).default(10080),

    // ── development affordances ──────────────────────────────────────────────
    ENABLE_API_DOCS: booleanFromString.default(false),
    ENABLE_TEST_SUPPORT: booleanFromString.default(false),

    // ── worker ───────────────────────────────────────────────────────────────
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(5),
  })
  .superRefine((env, ctx) => {
    type CredentialKey =
      | 'STRIPE_SECRET_KEY'
      | 'STRIPE_WEBHOOK_SECRET'
      | 'RESEND_API_KEY'
      | 'RESEND_WEBHOOK_SECRET'
      | 'TWILIO_ACCOUNT_SID'
      | 'TWILIO_AUTH_TOKEN'
      | 'TWILIO_FROM_NUMBER'
      | 'TWILIO_STATUS_CALLBACK_URL';

    const requireCredential = (key: CredentialKey, when: string): void => {
      if (isPlaceholder(env[key])) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} is required when ${when}`,
        });
      }
    };

    if (env.PAYMENT_PROVIDER === 'stripe') {
      requireCredential('STRIPE_SECRET_KEY', 'PAYMENT_PROVIDER is "stripe"');
      requireCredential('STRIPE_WEBHOOK_SECRET', 'PAYMENT_PROVIDER is "stripe"');
    }

    if (env.EMAIL_PROVIDER === 'resend') {
      requireCredential('RESEND_API_KEY', 'EMAIL_PROVIDER is "resend"');
      requireCredential('RESEND_WEBHOOK_SECRET', 'EMAIL_PROVIDER is "resend"');
    }

    if (env.SMS_PROVIDER === 'twilio') {
      requireCredential('TWILIO_ACCOUNT_SID', 'SMS_PROVIDER is "twilio"');
      requireCredential('TWILIO_AUTH_TOKEN', 'SMS_PROVIDER is "twilio"');
      requireCredential('TWILIO_FROM_NUMBER', 'SMS_PROVIDER is "twilio"');
      requireCredential('TWILIO_STATUS_CALLBACK_URL', 'SMS_PROVIDER is "twilio"');
    }

    if (env.SESSION_ABSOLUTE_TTL_MINUTES < env.SESSION_IDLE_TTL_MINUTES) {
      ctx.addIssue({
        code: 'custom',
        path: ['SESSION_ABSOLUTE_TTL_MINUTES'],
        message:
          'SESSION_ABSOLUTE_TTL_MINUTES must be greater than or equal to SESSION_IDLE_TTL_MINUTES',
      });
    }

    // A production deployment must never quietly run on in-memory fakes or
    // expose the test-support router.
    if (env.NODE_ENV === 'production') {
      for (const key of ['PAYMENT_PROVIDER', 'EMAIL_PROVIDER', 'SMS_PROVIDER'] as const) {
        if (env[key] === 'fake') {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `${key} must not be "fake" when NODE_ENV is "production"`,
          });
        }
      }
      if (env.ENABLE_TEST_SUPPORT) {
        ctx.addIssue({
          code: 'custom',
          path: ['ENABLE_TEST_SUPPORT'],
          message: 'ENABLE_TEST_SUPPORT must be false when NODE_ENV is "production"',
        });
      }
    }
  });

export type AppConfig = z.infer<typeof envSchema>;

/** Injection token for the parsed configuration. */
export const ENV = 'ENV_CONFIG';

interface FatalIo {
  write(message: string): void;
  exit(code: number): never;
}

const PROCESS_FATAL_IO: FatalIo = {
  write: (message) => {
    writeSync(process.stderr.fd, message);
  },
  exit: (code) => process.exit(code),
};

/** Write a fatal startup diagnostic completely before terminating the process. */
export function failFast(message: string, io: FatalIo = PROCESS_FATAL_IO): never {
  io.write(message);
  return io.exit(1);
}

/** Pure wrapper so tests can exercise validation without touching the process. */
export function parseConfig(raw: Record<string, string | undefined>) {
  return envSchema.safeParse(raw);
}

/** Guard destructive integration-test resets against near-miss database names. */
export function assertTestDatabaseUrl(value: string | undefined): string {
  if (value === undefined) {
    throw new Error(
      'Integration tests require the database name "booking_test"; received "(missing)".',
    );
  }

  let databaseName: string;
  try {
    databaseName = decodeURIComponent(new URL(value).pathname.slice(1)) || '(missing)';
  } catch {
    databaseName = '(invalid URL)';
  }

  if (databaseName !== 'booking_test') {
    throw new Error(
      `Integration tests require the database name "booking_test"; received "${databaseName}".`,
    );
  }

  return value;
}

let cached: AppConfig | undefined;

/**
 * Parse the ambient environment, or exit non-zero having named every problem at
 * once. Failing fast and completely beats discovering a missing variable on the
 * first request that needs it.
 *
 * Memoised so the entrypoint and the Nest provider share one parse result
 * rather than validating twice and risking two answers.
 */
export function loadConfig(): AppConfig {
  if (cached) return cached;

  const result = parseConfig(process.env);

  if (!result.success) {
    const lines = result.error.issues.map((issue) => {
      const key = issue.path.join('.') || '(root)';
      return `  ${key}: ${issue.message}`;
    });
    failFast(
      `Invalid configuration — ${String(lines.length)} problem(s):\n${lines.join('\n')}\n` +
        'See booking-app/.env.example for the expected variables.\n',
    );
  }

  cached = result.data;
  return cached;
}

/** Test seam: forget the memoised parse so a fresh environment can be read. */
export function resetConfigCache(): void {
  cached = undefined;
}

/**
 * Refuse to start when the process role does not match the entrypoint.
 *
 * Writes to stderr rather than through the Nest logger on purpose: the logger is
 * created with `bufferLogs: true` and its buffer is discarded by `process.exit`,
 * so a role mismatch would otherwise abort with no diagnostics at all.
 */
export function assertAppRole(config: AppConfig, expected: AppConfig['APP_ROLE']): void {
  if (config.APP_ROLE === expected) return;

  failFast(
    `APP_ROLE is "${config.APP_ROLE}" but this is the "${expected}" entrypoint.\n` +
      `Start it with APP_ROLE=${expected}, or run the ${config.APP_ROLE} entrypoint instead.\n`,
  );
}
