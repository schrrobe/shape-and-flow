import { baseVitestConfig } from '@shape-and-flow/booking-config/vitest';
import swc from 'unplugin-swc';
import { defineConfig, mergeConfig } from 'vitest/config';

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
      // Integration tests talk to a real database, so they need more than the
      // default five seconds and must not be aborted mid-transaction.
      testTimeout: 30_000,
      hookTimeout: 30_000,
      // The first integration tests arrive with the database harness in
      // Task 1.3. Until then there are legitimately none, and CI must stay
      // green; Task 1.3 flips this back to false.
      passWithNoTests: true,
      coverage: { enabled: false },
    },
  }),
);
