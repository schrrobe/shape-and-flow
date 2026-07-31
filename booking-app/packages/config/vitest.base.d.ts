import type { UserConfig } from 'vitest/config';

export declare const COVERAGE_EXCLUDE: string[];

/**
 * Vitest defaults shared by every package. Merge with a package-specific
 * config rather than mutating it.
 */
export declare const baseVitestConfig: UserConfig;

export default baseVitestConfig;
