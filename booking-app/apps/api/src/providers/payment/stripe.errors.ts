import Stripe from 'stripe';

/**
 * Reading Stripe failures.
 *
 * The distinction that matters most is retryable versus permanent. Retrying a
 * rejected card wastes attempts and delays the customer learning the truth;
 * giving up on a connection reset loses a refund that would have gone through a
 * second later. The expiry saga depends on the same split: a network error must
 * leave the booking EXPIRING and blocking, while a definitive answer must settle it.
 */

/**
 * True when `checkout.sessions.expire` failed because the customer had already
 * paid.
 *
 * Stripe reports this as an invalid-request error rather than a distinct code, so
 * the message is the only signal. Matching loosely on purpose — "already
 * complete", "has already been completed" — because the wording is not part of
 * Stripe's contract and a narrower match would silently turn a paid booking into
 * an expired one. The behaviour is pinned by tests using the wording observed
 * today, so a change in phrasing fails a test rather than losing a payment.
 */
export function isSessionAlreadyCompleteError(error: unknown): boolean {
  if (!(error instanceof Stripe.errors.StripeInvalidRequestError)) return false;
  return /already\b.*\bcomplet/i.test(error.message);
}

/** True when the session id does not exist at Stripe. */
export function isNoSuchSessionError(error: unknown): boolean {
  if (!(error instanceof Stripe.errors.StripeInvalidRequestError)) return false;
  return error.code === 'resource_missing' || /no such checkout\.session/i.test(error.message);
}

/**
 * True when the failure is transient and the operation should be retried.
 *
 * Deliberately a whitelist of transient classes rather than a blacklist of
 * permanent ones: an unrecognised Stripe error is treated as permanent, so a new
 * error class cannot silently cause an infinite retry loop against a paid charge.
 */
export function isRetryableStripeError(error: unknown): boolean {
  if (error instanceof Stripe.errors.StripeConnectionError) return true;
  if (error instanceof Stripe.errors.StripeRateLimitError) return true;

  // StripeAPIError covers Stripe's own 5xx responses.
  if (error instanceof Stripe.errors.StripeAPIError) return true;

  // A non-Stripe error here is almost always the socket layer.
  if (!(error instanceof Stripe.errors.StripeError) && error instanceof Error) {
    return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up/i.test(error.message);
  }

  return false;
}

/** A short, loggable description that never includes the request payload. */
export function describeStripeError(error: unknown): string {
  if (error instanceof Stripe.errors.StripeError) {
    const parts = [error.type, error.code, error.message].filter(
      (part): part is string => typeof part === 'string' && part !== '',
    );
    return parts.join(' | ');
  }
  return error instanceof Error ? error.message : String(error);
}
