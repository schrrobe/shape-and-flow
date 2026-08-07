import { z } from 'zod';

/**
 * The error contract.
 *
 * Every non-2xx response has exactly this shape, and clients switch on `code`,
 * never on `message`. That is what lets copy change per locale, and lets the
 * message stay in English for developers and logs, without breaking behaviour.
 *
 * `ErrorCode` is deliberately only the **public** set. Internal invariant
 * violations — a fractional cent, an unscoped tenant query — throw with codes
 * that are not listed here, and the exception filter turns any unrecognised code
 * into a generic 500 while logging the real one. So an internal code cannot leak
 * into a response by being forgotten; it has to be added here on purpose.
 */
export const errorCodeSchema = z.enum([
  // 400
  'VALIDATION_FAILED',
  'INVALID_RETURN_URL',
  // 401
  'UNAUTHENTICATED',
  // 403
  'CSRF_FAILED',
  'FORBIDDEN_ROLE',
  // 404 — also returned for a resource owned by another organization, because a
  // 403 would confirm the id exists.
  'NOT_FOUND',
  'ORGANIZATION_NOT_FOUND',
  // 409
  'SLOT_UNAVAILABLE',
  'IDEMPOTENT_REQUEST_IN_PROGRESS',
  'BOOKING_NOT_CANCELLABLE',
  'BOOKING_NOT_RESCHEDULABLE',
  'REQUEST_ALREADY_DECIDED',
  'EMPLOYEE_HAS_FUTURE_BOOKINGS',
  'SERVICE_HAS_FUTURE_BOOKINGS',
  'CATEGORY_NOT_EMPTY',
  'CANNOT_MODIFY_SELF',
  'PAYMENT_NOT_REFUNDABLE',
  'NO_EMPLOYEE_AVAILABLE',
  // 422
  'IDEMPOTENCY_KEY_REUSED',
  'OUTSIDE_BOOKING_WINDOW',
  'INVALID_STATUS_TRANSITION',
  'ORGANIZATION_CREATE_ERROR',
  'ORGANIZATION_ONBOARDING_INCOMPLETE',
  // 429
  'RATE_LIMITED',
  // 500
  'INTERNAL_ERROR',
  'ONBOARDING_LINK_ERROR',
]);

export type ErrorCode = z.infer<typeof errorCodeSchema>;

/**
 * The HTTP status each public code maps to.
 *
 * A test asserts this table and the enum are exhaustive over each other, so a new
 * code cannot be added without deciding its status.
 */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  INVALID_RETURN_URL: 400,

  UNAUTHENTICATED: 401,

  CSRF_FAILED: 403,
  FORBIDDEN_ROLE: 403,

  NOT_FOUND: 404,
  ORGANIZATION_NOT_FOUND: 404,

  SLOT_UNAVAILABLE: 409,
  IDEMPOTENT_REQUEST_IN_PROGRESS: 409,
  BOOKING_NOT_CANCELLABLE: 409,
  BOOKING_NOT_RESCHEDULABLE: 409,
  REQUEST_ALREADY_DECIDED: 409,
  // Three refusals to archive or edit something that is still in use. Separate codes
  // rather than one generic conflict because the office UI has to say a different
  // sentence for each — how many appointments are in the way, which services still sit
  // in the category, or that you cannot lock yourself out.
  EMPLOYEE_HAS_FUTURE_BOOKINGS: 409,
  SERVICE_HAS_FUTURE_BOOKINGS: 409,
  CATEGORY_NOT_EMPTY: 409,
  CANNOT_MODIFY_SELF: 409,
  PAYMENT_NOT_REFUNDABLE: 409,
  NO_EMPLOYEE_AVAILABLE: 409,

  IDEMPOTENCY_KEY_REUSED: 422,
  OUTSIDE_BOOKING_WINDOW: 422,
  INVALID_STATUS_TRANSITION: 422,
  ORGANIZATION_CREATE_ERROR: 422,
  ORGANIZATION_ONBOARDING_INCOMPLETE: 422,

  RATE_LIMITED: 429,

  INTERNAL_ERROR: 500,
  ONBOARDING_LINK_ERROR: 500,
};

/** True when a code is safe to return to a client. */
export function isPublicErrorCode(code: string): code is ErrorCode {
  return Object.hasOwn(ERROR_STATUS, code);
}

/** One field-level problem from a failed validation. */
export const validationIssueSchema = z.object({
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string(),
  code: z.string(),
});

export const errorEnvelopeSchema = z.object({
  code: errorCodeSchema,
  /** English, for developers and logs. Clients render copy keyed by `code`. */
  message: z.string(),
  /** Present only when there is something structured to say. */
  details: z.unknown().optional(),
  /** Ties the response to the log lines and jobs it produced. */
  correlationId: z.string(),
});

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
