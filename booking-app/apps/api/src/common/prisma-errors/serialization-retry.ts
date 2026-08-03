import { Logger } from '@nestjs/common';

import { isSerializationFailure } from './prisma-errors.js';

const logger = new Logger('SerializationRetry');

/** Attempts, including the first. Three is generous: a genuine conflict resolves on the retry. */
const MAX_ATTEMPTS = 3;

/** Small, jittered, and unmeasurable to a user. */
const BASE_DELAY_MS = 20;

/**
 * Retry a transaction that failed for a reason that left no trace.
 *
 * A serialization failure or a deadlock means PostgreSQL rolled the transaction back
 * whole — nothing was written, so running it again is not a duplicate, it is the
 * first successful attempt. Every other error propagates untouched: a constraint
 * violation would fail identically on a retry, and retrying it would only turn a
 * clear 409 into a slow one.
 *
 * The jitter matters more than the delay. Two transactions that deadlocked and then
 * retried in lockstep would deadlock again.
 */
export async function withSerializationRetry<T>(
  operation: () => Promise<T>,
  label = 'transaction',
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isSerializationFailure(error) || attempt >= MAX_ATTEMPTS) throw error;

      logger.warn(`${label} hit a serialization failure on attempt ${String(attempt)}; retrying`);

      await sleep(BASE_DELAY_MS * attempt * (1 + Math.random()));
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
