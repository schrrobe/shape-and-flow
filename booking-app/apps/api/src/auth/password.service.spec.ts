import { hash } from '@node-rs/argon2';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { ARGON2_OPTIONS } from './password.options.js';
import { DUMMY_HASH, PasswordService } from './password.service.js';

const passwords = new PasswordService();

const STRONG = 'a-sufficiently-long-password';

describe('DUMMY_HASH', () => {
  /**
   * The point of the constant is that an unknown email costs what a known one costs.
   * If a cost uplift edited ARGON2_OPTIONS and left this hash behind, verifying against
   * it would use the *hash's own* embedded parameters — cheaper than the real work — and
   * the timing difference this exists to remove would come back silently.
   */
  it('carries the same parameters a real hash would', async () => {
    const real = await hash(STRONG, ARGON2_OPTIONS);
    const parametersOf = (digest: string): string => digest.split('$').slice(0, 4).join('$');

    expect(parametersOf(DUMMY_HASH)).toBe(parametersOf(real));
  });

  it('is argon2id, and no password matches it', async () => {
    expect(DUMMY_HASH.startsWith('$argon2id$')).toBe(true);
    expect(await passwords.verify(DUMMY_HASH, STRONG)).toBe(false);
    expect(await passwords.verify(DUMMY_HASH, '')).toBe(false);
  });

  it('costs what a real verify costs', async () => {
    const real = await hash(STRONG, ARGON2_OPTIONS);

    const time = async (run: () => Promise<unknown>): Promise<number> => {
      const started = process.hrtime.bigint();
      await run();
      return Number(process.hrtime.bigint() - started) / 1e6;
    };

    // Warm the library up, so neither measurement pays for a first call.
    await passwords.verify(real, 'wrong-but-long-enough');

    const dummy = await time(() => passwords.verifyDummy('wrong-but-long-enough'));
    const genuine = await time(() => passwords.verify(real, 'wrong-but-long-enough'));

    // A ratio rather than a difference, and a generous one: this runs on shared CI
    // hardware and is not measuring precision. What it catches is the case that matters —
    // one path stopping hashing altogether, which shows up as a ratio in the thousands.
    expect(Math.max(dummy, genuine) / Math.min(dummy, genuine)).toBeLessThan(3);
  });
});

describe('hash', () => {
  it('round-trips a password it accepted', async () => {
    const digest = await passwords.hash(STRONG);

    expect(await passwords.verify(digest, STRONG)).toBe(true);
    expect(await passwords.verify(digest, `${STRONG}!`)).toBe(false);
  });

  it('refuses to store a password that is too short', async () => {
    // The rule holds for every path that writes a password, not only the ones whose
    // request body happened to be parsed with the right schema.
    await expect(passwords.hash('short')).rejects.toThrow(ZodError);
  });

  it('refuses to store a common password even when it is long enough', async () => {
    await expect(passwords.hash('passwordpassword')).rejects.toThrow(ZodError);
    await expect(passwords.hash('PasswordPassword')).rejects.toThrow(ZodError);
  });
});

describe('verify', () => {
  it('reports a corrupt stored hash as a mismatch rather than throwing', async () => {
    // A truncated row is a broken record, not a wrong password — but the caller must not
    // be able to tell the difference, or the difference becomes an oracle.
    expect(await passwords.verify('not-a-hash', STRONG)).toBe(false);
    expect(await passwords.verify('', STRONG)).toBe(false);
  });
});

describe('assertStrong', () => {
  it('accepts exactly twelve characters, and refuses eleven', () => {
    expect(() => {
      passwords.assertStrong('abcdefghijkl');
    }).not.toThrow();
    expect(() => {
      passwords.assertStrong('abcdefghijk');
    }).toThrow(ZodError);
  });

  it('refuses a long password that is on the deny list', () => {
    // Long enough to pass the length rule, which is exactly why the list exists.
    expect(() => {
      passwords.assertStrong('123456789012');
    }).toThrow(ZodError);
  });
});
