import { describe, expect, it } from 'vitest';

import { parseConfig } from '../config/env.schema.js';

import { TestSupportModule, testSupportImports } from './test-support.module.js';

import type { AppConfig } from '../config/env.schema.js';

/**
 * The gate, tested apart from the router it gates.
 *
 * The router resets databases and marks payments received. "Not reachable" is the
 * only acceptable state for it in anything but a test environment, and two separate
 * things have to hold for that: the flag defaults off and is refused in production,
 * and the module is genuinely absent from the container rather than merely guarded.
 */

const baseEnv = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://booking:booking@db:5432/booking',
  REDIS_URL: 'redis://redis:6379',
  DEFAULT_ORGANIZATION_SLUG: 'shape-and-flow',
  PUBLIC_WEB_ORIGIN: 'https://shape-and-flow.example',
  PUBLIC_API_ORIGIN: 'https://api.shape-and-flow.example',
  PAYMENT_PROVIDER: 'stripe',
  STRIPE_SECRET_KEY: 'sk_live_x',
  STRIPE_WEBHOOK_SECRET: 'whsec_x',
  EMAIL_PROVIDER: 'resend',
  EMAIL_FROM_ADDRESS: 'hallo@shape-and-flow.example',
  EMAIL_FROM_NAME: 'Shape and Flow',
  RESEND_API_KEY: 're_x',
  RESEND_WEBHOOK_SECRET: 'whsec_resend',
  SMS_PROVIDER: 'twilio',
  TWILIO_ACCOUNT_SID: 'AC_x',
  TWILIO_AUTH_TOKEN: 'tok_x',
  TWILIO_FROM_NUMBER: '+4915100000000',
  TWILIO_STATUS_CALLBACK_URL: 'https://api.shape-and-flow.example/api/webhooks/twilio',
};

describe('testSupportImports', () => {
  it('adds nothing when the flag is off, which is the default', () => {
    expect(testSupportImports({ ENABLE_TEST_SUPPORT: false } as AppConfig)).toEqual([]);
  });

  it('adds the module when the flag is on', () => {
    expect(testSupportImports({ ENABLE_TEST_SUPPORT: true } as AppConfig)).toEqual([
      TestSupportModule,
    ]);
  });
});

describe('the configuration that decides it', () => {
  it('refuses to start in production with the router enabled', () => {
    const result = parseConfig({ ...baseEnv, ENABLE_TEST_SUPPORT: 'true' });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain(
      'ENABLE_TEST_SUPPORT',
    );
  });

  it('starts in production with the router disabled', () => {
    expect(parseConfig({ ...baseEnv, ENABLE_TEST_SUPPORT: 'false' }).success).toBe(true);
  });

  it('leaves it off when nothing says otherwise', () => {
    const result = parseConfig(baseEnv);

    expect(result.success).toBe(true);
    expect(result.data?.ENABLE_TEST_SUPPORT).toBe(false);
  });
});
