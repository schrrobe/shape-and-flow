/**
 * Types for vitest.base.js.
 *
 * Deliberately self-contained: this declaration imports nothing. An earlier
 * version imported `UserConfig` from 'vitest/config', and because consumers
 * compile with `skipLibCheck`, a failed resolution inside this file degraded
 * silently to `any` — which then propagated into every consumer's Vitest
 * config without a single error. A structural type cannot fail that way.
 *
 * Vitest's own `mergeConfig` accepts plain objects, so no Vitest type is needed
 * here to compose this with a package-specific config.
 */

export interface CoverageThresholds {
  lines: number;
  statements: number;
  functions: number;
  branches: number;
}

export interface BaseCoverageConfig {
  provider: 'v8';
  reporter: string[];
  exclude: string[];
  thresholds: CoverageThresholds;
}

export interface BaseTestConfig {
  globals: boolean;
  restoreMocks: boolean;
  clearMocks: boolean;
  unstubEnvs: boolean;
  unstubGlobals: boolean;
  passWithNoTests: boolean;
  reporters: string[];
  coverage: BaseCoverageConfig;
}

export interface BaseVitestConfig {
  test: BaseTestConfig;
}

export declare const COVERAGE_EXCLUDE: string[];

/** Vitest defaults shared by every package. Compose with `mergeConfig`. */
export declare const baseVitestConfig: BaseVitestConfig;
