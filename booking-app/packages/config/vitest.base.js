/**
 * Shared Vitest defaults for every package in the booking app.
 *
 * Authored as plain ESM rather than TypeScript on purpose: Vitest loads a
 * package's `vitest.config.ts` through Vite's config loader, which externalises
 * linked workspace dependencies instead of transforming them. A `.ts` export
 * would therefore reach Node untransformed. Types live in vitest.base.d.ts.
 */

/** Paths that are never meaningful coverage targets. */
export const COVERAGE_EXCLUDE = [
  '**/node_modules/**',
  '**/dist/**',
  '**/coverage/**',
  '**/test/**',
  '**/e2e/**',
  '**/*.config.{ts,js,mjs}',
  '**/*.spec.{ts,tsx}',
  '**/*.int.spec.ts',
  '**/*.d.ts',
  '**/main.ts',
  '**/worker.main.ts',
  '**/*.module.ts',
  '**/prisma/seed.ts',
  '**/src/generated/**',
  // Its behavior is exercised against real Prisma/Postgres by the integration
  // suite; counting it in the isolated unit report would force a second,
  // mock-based copy of the same security tests.
  '**/tenant.extension.ts',
];

export const baseVitestConfig = {
  test: {
    // Explicit imports from 'vitest' keep test files honest about what they use.
    globals: false,
    restoreMocks: true,
    clearMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    passWithNoTests: false,
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.{ts,tsx,js,jsx}'],
      exclude: COVERAGE_EXCLUDE,
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 70,
      },
    },
  },
};
