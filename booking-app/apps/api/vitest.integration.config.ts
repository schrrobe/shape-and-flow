import { baseVitestConfig } from '@shape-and-flow/booking-config/vitest';
import swc from 'unplugin-swc';
import { defineConfig, mergeConfig } from 'vitest/config';

const TEST_DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://booking:booking@localhost:5434/booking_test?schema=public';
const TEST_REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6381';

export default mergeConfig(
  baseVitestConfig,
  defineConfig({
    // See vitest.config.ts: required so SWC's decorator-metadata transform
    // actually replaces Vite's built-in Oxc transform.
    oxc: false,
    plugins: [
      swc.vite({
        module: { type: 'es6' },
        jsc: {
          target: 'es2023',
          parser: { syntax: 'typescript', decorators: true },
          transform: { legacyDecorator: true, decoratorMetadata: true },
        },
      }),
    ],
    test: {
      name: 'integration',
      environment: 'node',
      include: ['test/integration/**/*.int.spec.ts'],
      setupFiles: ['./test/setup.integration.ts'],
      // One database, truncated between tests. Several of these tests
      // deliberately provoke lock contention and constraint violations, and a
      // single serialised database makes those outcomes unambiguous.
      fileParallelism: false,
      // Forked child processes rather than worker threads: with fileParallelism
      // off there is nothing to gain from threads, and a fork can be terminated
      // if a run ever does get stuck — a worker thread cannot.
      pool: 'forks',
      // Real database round trips, and some tests hold advisory locks.
      testTimeout: 30_000,
      hookTimeout: 30_000,
      // Teardown only closes a pool; if it takes longer than this, something is
      // wrong and failing fast beats a hung CI job.
      teardownTimeout: 10_000,
      env: {
        NODE_ENV: 'test',
        DATABASE_URL: TEST_DATABASE_URL,
        REDIS_URL: TEST_REDIS_URL,
        // The queue tests obliterate every queue between tests. A prefix of its
        // own means that reset cannot reach an application's queues even if
        // REDIS_URL is pointed at the development instance; test/redis.harness.ts
        // refuses to run without it.
        REDIS_QUEUE_PREFIX: 'test-bull',
        // The rest of what `env.schema.ts` requires. Most suites inject a stub config
        // through the harness, but the worker-bootstrap suite builds the real container
        // and therefore the real configuration -- which is the point of that suite.
        DEFAULT_ORGANIZATION_SLUG: 'shape-and-flow',
        PUBLIC_WEB_ORIGIN: 'http://localhost:3000',
        PUBLIC_API_ORIGIN: 'http://localhost:3001',
        EMAIL_FROM_ADDRESS: 'test@shape-and-flow.example',
        EMAIL_FROM_NAME: 'Shape and Flow (test)',
      },
      coverage: { enabled: false },
    },
  }),
);
