import { Injectable, Logger } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { newPasswordSchema } from '@shape-and-flow/booking-contracts';

import { ARGON2_OPTIONS } from './password.options.js';

/**
 * A real argon2id hash, of a password no account has.
 *
 * Verified against whenever the presented email matches nobody. Without it, an
 * unknown address would answer in microseconds while a known one spends ~50ms
 * hashing, and that difference is measurable over a handful of requests — which makes
 * the login endpoint an account-enumeration oracle however carefully its error
 * messages were made identical.
 *
 * Embedded as a constant rather than computed at start-up or on first use: computing
 * it lazily would make the *first* unknown-email login slower than the rest, which is
 * the same leak in a subtler form. Exported so password.service.spec.ts can assert its
 * parameters still match ARGON2_OPTIONS — a cost uplift that forgot this constant
 * would quietly reintroduce the timing difference.
 */
export const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$eAnScq4znFCjo9Vmn2EfYw$0SQk1CTc8BeWYXSnJkJlJdlcoEcygnm/mOF4oUYcAHg';

/**
 * Hashing, verifying, and refusing weak passwords.
 *
 * Thin on purpose. The interesting decisions live elsewhere — the cost parameters in
 * password.options.ts, the strength rule in the contracts package so the browser
 * checks the same one — and what remains here is the part that cannot live in either:
 * making a failed lookup cost the same as a failed verify.
 */
@Injectable()
export class PasswordService {
  private readonly logger = new Logger('Password');

  /**
   * Hash a password that is about to be stored.
   *
   * Asserts strength first, so the rule holds for every path that writes a password —
   * the reset flow, the change flow, office-user creation, the seed — rather than only
   * for the ones whose request body happened to be parsed with the right schema.
   */
  async hash(plain: string): Promise<string> {
    this.assertStrong(plain);
    return await hash(plain, ARGON2_OPTIONS);
  }

  /**
   * Whether `plain` produced `digest`.
   *
   * A malformed or truncated stored hash makes the library throw. That is a broken row
   * rather than a wrong password, but the caller must not be able to tell the
   * difference, so it is logged and reported as a mismatch.
   */
  async verify(digest: string, plain: string): Promise<boolean> {
    try {
      return await verify(digest, plain, ARGON2_OPTIONS);
    } catch (error) {
      this.logger.error(
        `stored password hash could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  /**
   * Spend what a real verify would have spent, and discard the answer.
   *
   * Called on the branch where no user matched, so that branch costs what the
   * wrong-password branch costs.
   */
  async verifyDummy(plain: string): Promise<void> {
    await this.verify(DUMMY_HASH, plain);
  }

  /**
   * Refuse a password that is too short or too common.
   *
   * Delegates to the contracts schema rather than restating the rule, so the browser's
   * check and this one are the same check. Throws a ZodError, which the exception
   * filter renders as `400 VALIDATION_FAILED` — the shape every other rejected input
   * produces.
   */
  assertStrong(plain: string): void {
    newPasswordSchema.parse(plain);
  }
}
