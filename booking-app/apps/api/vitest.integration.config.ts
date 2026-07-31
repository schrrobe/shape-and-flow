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
      // Real database round trips, and some tests hold advisory locks.
      testTimeout: 30_000,
      hookTimeout: 30_000,
      env: {
        NODE_ENV: 'test',
        DATABASE_URL: TEST_DATABASE_URL,
        REDIS_URL: TEST_REDIS_URL,
      },
      coverage: { enabled: false },
    },
  }),
);
