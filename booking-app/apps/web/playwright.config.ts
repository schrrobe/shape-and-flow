import { defineConfig, devices } from '@playwright/test';

/**
 * The end-to-end suite: a real browser, a real API, a real worker, real Postgres and
 * real Redis. Only the payment provider, the mail provider and the SMS gateway are
 * fakes, and those are fakes in development too.
 *
 * Three servers rather than one. The API and the worker are separate processes in
 * production and the difference is not cosmetic — the expiry saga hands work from one
 * to the other, and a suite that ran them in a single container would not have caught
 * that the fake payment provider kept its sessions per process. The web tier is the
 * `vite preview` server serving the built bundle, proxying `/api` so the browser sees
 * one origin, exactly as a deployment does.
 *
 * Everything here points at a disposable database. `booking_e2e` is a different
 * database from the integration suite's `booking_test`, so an e2e run and an
 * integration run cannot truncate each other's tables.
 */

const API_PORT = 3100;
const WEB_PORT = 4173;

const API_ORIGIN = `http://localhost:${String(API_PORT)}`;
const WEB_ORIGIN = `http://localhost:${String(WEB_PORT)}`;

/** CI supplies its own service containers; the defaults are the local test stack. */
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  'postgresql://booking:booking@localhost:5434/booking_e2e?schema=public';
/**
 * Logical database 1, not 0.
 *
 * The integration suite runs against the same Redis server on database 0. Queues are
 * already kept apart by their prefix, but sessions and rate-limit counters are not
 * prefixed at all, and the test-support reset deletes those by pattern. A separate
 * database means the two suites cannot reach each other's keys even by accident.
 */
const REDIS_URL = process.env.E2E_REDIS_URL ?? 'redis://localhost:6381/1';

/**
 * Known credentials, on purpose.
 *
 * The seed generates a password and prints it once, which is right for a database a
 * person will use and useless for one a test logs into. These are passed to the
 * test-support reset, which is only reachable when ENABLE_TEST_SUPPORT is true.
 */
export const E2E_OWNER_PASSWORD = 'e2e-owner-password';
export const E2E_STAFF_PASSWORD = 'e2e-staff-password';

export const stackEnv = {
  NODE_ENV: 'test',
  DATABASE_URL,
  REDIS_URL,
  // Its own prefix, so obliterating the e2e queues cannot reach the integration
  // suite's jobs even though both run against the same Redis server.
  REDIS_QUEUE_PREFIX: 'e2e-bull',
  DEFAULT_ORGANIZATION_SLUG: 'shape-and-flow',
  PUBLIC_WEB_ORIGIN: WEB_ORIGIN,
  PUBLIC_API_ORIGIN: API_ORIGIN,
  PAYMENT_PROVIDER: 'fake',
  EMAIL_PROVIDER: 'fake',
  SMS_PROVIDER: 'fake',
  EMAIL_FROM_ADDRESS: 'hallo@shape-and-flow.example',
  EMAIL_FROM_NAME: 'Shape and Flow',
  ENABLE_TEST_SUPPORT: 'true',
  // Consumed by dist/seed.main.js on the API's first boot, so the logins the suite
  // uses are the logins the database has.
  SEED_OWNER_PASSWORD: E2E_OWNER_PASSWORD,
  SEED_STAFF_PASSWORD: E2E_STAFF_PASSWORD,
  // The suite asserts on what the product does, not on how loudly it says so, and a
  // failing test is read from the trace rather than from the servers' stdout.
  LOG_LEVEL: 'warn',
};

export default defineConfig({
  testDir: './e2e',
  // The worker is started here rather than as a `webServer` entry, because a
  // `webServer` must expose a port to poll and a worker deliberately exposes none.
  globalSetup: './e2e/global-setup.ts',
  // Every spec resets the one database, so they cannot overlap. The parallelism that
  // matters here is between the browser and three servers, not between test files.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI === undefined ? 0 : 1,
  // Real payments, real queues, a real worker picking the job up: a journey has more
  // round trips in it than a component test, and the default 30s is tight for the
  // ones that wait for a drain.
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI === undefined ? [['list']] : [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: WEB_ORIGIN,
    // The app marks the elements a test drives with `data-test`; Playwright looks for
    // `data-testid` unless told otherwise, and the mismatch fails as "element not
    // found", which is the least informative way to learn about a convention.
    testIdAttribute: 'data-test',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    {
      // 360 px is the narrow end of what real phones report, and the booking flow is
      // the part of this product most people will only ever see on one.
      name: 'mobile',
      use: { ...devices['Desktop Chrome'], viewport: { width: 360, height: 780 }, isMobile: false },
      testIgnore: /accessibility\.spec\.ts/,
    },
  ],

  webServer: [
    {
      // Migrated and seeded first, and neither is convenience. Prisma creates the
      // database if it is not there, so a developer needs no setup step and cannot run
      // against a schema two migrations behind — which is a mistake task 11.2's
      // readiness probe caught the hard way. And the API refuses to start against a
      // database with no organization in it, while the router that reseeds between
      // tests lives inside the API. Both commands are idempotent.
      command: 'pnpm exec prisma migrate deploy && node dist/seed.main.js && node dist/main.js',
      cwd: '../api',
      url: `${API_ORIGIN}/api/health/ready`,
      env: { ...stackEnv, APP_ROLE: 'api', PORT: String(API_PORT) },
      reuseExistingServer: process.env.CI === undefined,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 60_000,
    },
    {
      command: `pnpm exec vite preview --port ${String(WEB_PORT)} --strictPort`,
      url: WEB_ORIGIN,
      env: { VITE_API_TARGET: API_ORIGIN },
      reuseExistingServer: process.env.CI === undefined,
      timeout: 60_000,
    },
  ],
});
