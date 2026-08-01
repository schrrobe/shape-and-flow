import type { Options } from '@node-rs/argon2';

/**
 * argon2id parameters, in one place.
 *
 * These are the OWASP-recommended baseline: 19 MiB of memory, two iterations,
 * one lane. Keeping them as a single exported constant means a future uplift is
 * one edit plus a rehash-on-login path, rather than a search for every call site
 * that happened to hash a password.
 *
 * `@node-rs/argon2` is used instead of the `argon2` package because it ships
 * prebuilt binaries: no native toolchain is needed to install this repository,
 * and pnpm's build-script gating stays a short, auditable list.
 *
 * `algorithm` is deliberately not set. The library's own `Algorithm` enum is an
 * ambient const enum, which cannot be referenced under `verbatimModuleSyntax`,
 * and hard-coding its numeric value would be a magic number that silently rots
 * if the library reorders it. Argon2id is the library default, and
 * password.options.spec.ts asserts that by checking a real hash begins with
 * `$argon2id$` — which is stronger evidence than naming the constant.
 */
export const ARGON2_OPTIONS: Options = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

/** Minimum length accepted for an office password. */
export const MIN_PASSWORD_LENGTH = 12;
