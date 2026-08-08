import { describe, expect, it } from 'vitest';

import { assertTestDatabaseUrl, envSchema, failFast, parseConfig } from './env.schema.js';

/** A minimal environment that must validate. Anything omitted has a default. */
const valid: Record<string, string> = {
  NODE_ENV: 'test',
  APP_ROLE: 'api',
  PORT: '3000',
  LOG_LEVEL: 'error',
  DATABASE_URL: 'postgresql://booking:booking@localhost:5434/booking_test?schema=public',
  REDIS_URL: 'redis://localhost:6381',
  DEFAULT_ORGANIZATION_SLUG: 'shape-and-flow',
  PUBLIC_WEB_ORIGIN: 'http://localhost:5173',
  PUBLIC_API_ORIGIN: 'http://localhost:3000',
  PAYMENT_PROVIDER: 'fake',
  EMAIL_PROVIDER: 'fake',
  EMAIL_FROM_ADDRESS: 'buchung@example.com',
  EMAIL_FROM_NAME: 'Shape and Flow',
  SMS_PROVIDER: 'fake',
  SESSION_COOKIE_NAME: 'sf_office_session',
  SESSION_IDLE_TTL_MINUTES: '720',
  SESSION_ABSOLUTE_TTL_MINUTES: '10080',
  ENABLE_API_DOCS: 'false',
};

const paths = (result: ReturnType<typeof parseConfig>): string[] =>
  result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));

describe('envSchema', () => {
  it('accepts a minimal valid environment', () => {
    expect(parseConfig(valid).success).toBe(true);
  });

  it('coerces numeric strings to numbers', () => {
    const parsed = envSchema.parse(valid);
    expect(parsed.PORT).toBe(3000);
    expect(parsed.DATABASE_POOL_SIZE).toBe(10);
    expect(parsed.SESSION_IDLE_TTL_MINUTES).toBe(720);
    expect(typeof parsed.PORT).toBe('number');
  });

  it('coerces boolean-ish strings to booleans', () => {
    expect(envSchema.parse({ ...valid, ENABLE_API_DOCS: 'true' }).ENABLE_API_DOCS).toBe(true);
    expect(envSchema.parse({ ...valid, ENABLE_API_DOCS: '0' }).ENABLE_API_DOCS).toBe(false);
  });

  it('applies documented defaults for omitted optional variables', () => {
    const parsed = envSchema.parse(valid);
    expect(parsed.WORKER_CONCURRENCY).toBe(5);
    expect(parsed.ENABLE_TEST_SUPPORT).toBe(false);
  });

  it('logs every request by default, and samples only when told to', () => {
    // A deployment that has not thought about log volume must not silently be
    // dropping lines: sampling is something an operator turns on.
    expect(envSchema.parse(valid).LOG_SAMPLE_RATE).toBe(1);
    expect(envSchema.parse({ ...valid, LOG_SAMPLE_RATE: '0.05' }).LOG_SAMPLE_RATE).toBe(0.05);
  });

  it('rejects a sample rate outside 0 to 1', () => {
    expect(paths(parseConfig({ ...valid, LOG_SAMPLE_RATE: '1.5' }))).toContain('LOG_SAMPLE_RATE');
    expect(paths(parseConfig({ ...valid, LOG_SAMPLE_RATE: '-0.1' }))).toContain('LOG_SAMPLE_RATE');
  });

  it('rejects an unknown APP_ROLE and names the variable', () => {
    const result = parseConfig({ ...valid, APP_ROLE: 'both' });
    expect(result.success).toBe(false);
    expect(paths(result)).toContain('APP_ROLE');
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    expect(parseConfig({ ...valid, DATABASE_URL: 'mysql://x/y' }).success).toBe(false);
  });

  it('rejects a non-redis REDIS_URL', () => {
    expect(parseConfig({ ...valid, REDIS_URL: 'http://localhost:6379' }).success).toBe(false);
  });

  it('rejects a malformed origin and a malformed sender address', () => {
    expect(parseConfig({ ...valid, PUBLIC_WEB_ORIGIN: 'not-a-url' }).success).toBe(false);
    expect(parseConfig({ ...valid, EMAIL_FROM_ADDRESS: 'nope' }).success).toBe(false);
  });

  it('accepts only bare HTTP(S) origins and normalises a trailing slash', () => {
    expect(
      envSchema.parse({ ...valid, PUBLIC_WEB_ORIGIN: 'https://example.com/' }).PUBLIC_WEB_ORIGIN,
    ).toBe('https://example.com');

    for (const origin of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'https://example.com/booking',
      'https://example.com?next=booking',
      'https://user:password@example.com',
    ]) {
      expect(parseConfig({ ...valid, PUBLIC_WEB_ORIGIN: origin }).success, origin).toBe(false);
    }
  });

  it('requires the absolute session lifetime to cover the idle lifetime', () => {
    const result = parseConfig({
      ...valid,
      SESSION_IDLE_TTL_MINUTES: '120',
      SESSION_ABSOLUTE_TTL_MINUTES: '60',
    });

    expect(result.success).toBe(false);
    expect(paths(result)).toContain('SESSION_ABSOLUTE_TTL_MINUTES');
  });

  it('bounds the database pool size', () => {
    expect(parseConfig({ ...valid, DATABASE_POOL_SIZE: '0' }).success).toBe(false);
    expect(parseConfig({ ...valid, DATABASE_POOL_SIZE: '101' }).success).toBe(false);
    expect(envSchema.parse({ ...valid, DATABASE_POOL_SIZE: '4' }).DATABASE_POOL_SIZE).toBe(4);
  });

  it('accepts only the exact disposable integration database name', () => {
    expect(assertTestDatabaseUrl).toBeTypeOf('function');
    expect(
      assertTestDatabaseUrl(
        'postgresql://booking:secret@localhost:5434/booking_test?schema=public',
      ),
    ).toContain('/booking_test?');
    expect(() =>
      assertTestDatabaseUrl(
        'postgresql://booking:secret@localhost:5434/production_booking_test?schema=public',
      ),
    ).toThrow(/production_booking_test/);
    expect(() =>
      assertTestDatabaseUrl('postgresql://booking:secret@localhost:5434/booking?schema=public'),
    ).toThrow(/booking/);
  });

  it('requires RESEND_API_KEY when EMAIL_PROVIDER is resend', () => {
    const result = parseConfig({ ...valid, EMAIL_PROVIDER: 'resend' });
    expect(result.success).toBe(false);
    expect(result.success ? [] : result.error.issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([expect.stringContaining('RESEND_API_KEY')]),
    );
  });

  it('treats a replace_me placeholder as absent', () => {
    const result = parseConfig({
      ...valid,
      EMAIL_PROVIDER: 'resend',
      RESEND_API_KEY: 're_replace_me',
      RESEND_WEBHOOK_SECRET: 'whsec_replace_me',
    });
    expect(result.success).toBe(false);
    expect(paths(result)).toContain('RESEND_API_KEY');
  });

  it('accepts resend once real credentials are supplied', () => {
    expect(
      parseConfig({
        ...valid,
        EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 're_live_abc123',
        RESEND_WEBHOOK_SECRET: 'whsec_live_abc123',
      }).success,
    ).toBe(true);
  });

  it('requires every Twilio credential when SMS_PROVIDER is twilio', () => {
    const result = parseConfig({ ...valid, SMS_PROVIDER: 'twilio' });
    expect(result.success).toBe(false);
    expect(paths(result)).toEqual(
      expect.arrayContaining([
        'TWILIO_ACCOUNT_SID',
        'TWILIO_AUTH_TOKEN',
        'TWILIO_FROM_NUMBER',
        'TWILIO_STATUS_CALLBACK_URL',
      ]),
    );
  });

  it('requires Stripe credentials when PAYMENT_PROVIDER is stripe', () => {
    const result = parseConfig({ ...valid, PAYMENT_PROVIDER: 'stripe' });
    expect(result.success).toBe(false);
    expect(paths(result)).toEqual(
      expect.arrayContaining([
        'STRIPE_SECRET_KEY',
        'STRIPE_WEBHOOK_SECRET',
        'STRIPE_CONNECT_WEBHOOK_SECRET',
      ]),
    );
  });

  it('accepts stripe once the Connect secret is supplied alongside the other two', () => {
    // Self-service organizer registration always onboards through Stripe Connect, so a
    // stripe deployment missing this secret must fail here rather than at the first
    // organizer's first account.updated event.
    expect(
      parseConfig({
        ...valid,
        PAYMENT_PROVIDER: 'stripe',
        STRIPE_SECRET_KEY: 'sk_live_abc123',
        STRIPE_WEBHOOK_SECRET: 'whsec_live_abc123',
        STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_live_connect123',
      }).success,
    ).toBe(true);
  });

  it('treats a replace_me Connect webhook secret as absent', () => {
    const result = parseConfig({
      ...valid,
      PAYMENT_PROVIDER: 'stripe',
      STRIPE_SECRET_KEY: 'sk_live_abc123',
      STRIPE_WEBHOOK_SECRET: 'whsec_live_abc123',
      STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_replace_me',
    });
    expect(result.success).toBe(false);
    expect(paths(result)).toContain('STRIPE_CONNECT_WEBHOOK_SECRET');
  });

  it('writes fatal startup diagnostics synchronously before exiting', () => {
    const calls: string[] = [];

    expect(() =>
      failFast('broken\n', {
        write: (message) => calls.push(`write:${message}`),
        exit: (code) => {
          calls.push(`exit:${String(code)}`);
          throw new Error('exited');
        },
      }),
    ).toThrow('exited');
    expect(calls).toEqual(['write:broken\n', 'exit:1']);
  });

  it('refuses fake providers in production', () => {
    const result = parseConfig({
      ...valid,
      NODE_ENV: 'production',
      PAYMENT_PROVIDER: 'fake',
      EMAIL_PROVIDER: 'fake',
      SMS_PROVIDER: 'fake',
    });
    expect(paths(result)).toEqual(
      expect.arrayContaining(['PAYMENT_PROVIDER', 'EMAIL_PROVIDER', 'SMS_PROVIDER']),
    );
  });

  it('refuses the test-support router in production', () => {
    const result = parseConfig({
      ...valid,
      NODE_ENV: 'production',
      PAYMENT_PROVIDER: 'stripe',
      STRIPE_SECRET_KEY: 'sk_live_x',
      STRIPE_WEBHOOK_SECRET: 'whsec_live_x',
      EMAIL_PROVIDER: 'resend',
      RESEND_API_KEY: 're_live_x',
      RESEND_WEBHOOK_SECRET: 'whsec_live_y',
      SMS_PROVIDER: 'fake',
      ENABLE_TEST_SUPPORT: 'true',
    });
    expect(paths(result)).toContain('ENABLE_TEST_SUPPORT');
  });

  it('reports every missing variable at once rather than only the first', () => {
    const result = parseConfig({ NODE_ENV: 'test' });
    expect(result.success).toBe(false);
    expect(result.success ? 0 : result.error.issues.length).toBeGreaterThan(5);
  });
});
