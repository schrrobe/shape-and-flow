/**
 * What must never appear in a log line.
 *
 * A massage studio's booking data is ordinary contact data, but the customer note
 * field invites the kind of disclosure that would turn it into a special category
 * of personal data — so it is redacted alongside credentials rather than treated as
 * free text.
 *
 * `Idempotency-Key` is in the list because it is the only thing that returns a
 * Stripe Checkout URL: a logged key is a payment session anyone can resume.
 *
 * Paths are explicit rather than clever. A wildcard that silently stops matching
 * after a shape change is worse than a list that a test walks, and
 * redaction.spec.ts logs an object containing every one of these and asserts none
 * survives.
 */
export const REDACT_PATHS = [
  // credentials in transit
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'req.headers["idempotency-key"]',
  'headers.authorization',
  'headers.cookie',
  'headers["idempotency-key"]',

  // credentials in bodies
  'password',
  'newPassword',
  'currentPassword',
  'body.password',
  'body.newPassword',
  'body.currentPassword',
  'req.body.password',
  'req.body.newPassword',
  'req.body.currentPassword',

  // secrets and tokens
  'token',
  'tokenHash',
  'idempotencyKey',
  // The plaintext management token, which travels in the booking.confirmed job
  // payload so the confirmation email can contain the link. `*.token` does not
  // match it, and a logged job payload would otherwise hand out the link that
  // cancels or reschedules the booking.
  'managementToken',
  // The Stripe Account Link. A one-time URL that walks straight into the organizer's
  // Stripe onboarding without asking who is holding it — so it belongs in a response
  // body and nowhere else, least of all in an audit row and its backups.
  'onboardingLink',
  '*.token',
  '*.tokenHash',
  '*.idempotencyKey',
  '*.managementToken',
  '*.onboardingLink',

  // personal data
  'email',
  'phone',
  'emailNormalized',
  'customerNote',
  '*.email',
  '*.phone',
  '*.emailNormalized',
  '*.customerNote',
  'body.customer.email',
  'body.customer.phone',
  'body.customerNote',
  'req.body.customer.email',
  'req.body.customer.phone',
  'req.body.customerNote',
] as const;

export const REDACT_CENSOR = '[Redacted]';
