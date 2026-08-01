import { hash, verify } from '@node-rs/argon2';
import { describe, expect, it } from 'vitest';

import { ARGON2_OPTIONS, MIN_PASSWORD_LENGTH } from './password.options.js';

/**
 * ARGON2_OPTIONS omits `algorithm` because the library's enum is an ambient
 * const enum that cannot be referenced under verbatimModuleSyntax. These tests
 * are what make that safe: they assert the produced hash really is argon2id,
 * with the intended cost parameters, rather than trusting a default.
 */
describe('ARGON2_OPTIONS', () => {
  it('produces an argon2id hash, not argon2i or argon2d', async () => {
    const digest = await hash('a-sufficiently-long-password', ARGON2_OPTIONS);
    expect(digest.startsWith('$argon2id$')).toBe(true);
  });

  it('encodes the intended cost parameters into the hash', async () => {
    const digest = await hash('a-sufficiently-long-password', ARGON2_OPTIONS);
    expect(digest).toContain('m=19456');
    expect(digest).toContain('t=2');
    expect(digest).toContain('p=1');
  });

  it('round-trips a correct password and rejects a wrong one', async () => {
    const digest = await hash('a-sufficiently-long-password', ARGON2_OPTIONS);
    expect(await verify(digest, 'a-sufficiently-long-password')).toBe(true);
    expect(await verify(digest, 'a-sufficiently-long-passwore')).toBe(false);
  });

  it('salts, so the same password hashes differently every time', async () => {
    const first = await hash('a-sufficiently-long-password', ARGON2_OPTIONS);
    const second = await hash('a-sufficiently-long-password', ARGON2_OPTIONS);
    expect(first).not.toBe(second);
    expect(await verify(second, 'a-sufficiently-long-password')).toBe(true);
  });

  it('requires at least twelve characters', () => {
    expect(MIN_PASSWORD_LENGTH).toBeGreaterThanOrEqual(12);
  });
});
