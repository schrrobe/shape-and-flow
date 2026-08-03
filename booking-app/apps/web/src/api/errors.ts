import { errorCodeSchema } from '@shape-and-flow/booking-contracts';
import { z } from 'zod';

import type { ErrorCode } from '@shape-and-flow/booking-contracts';

/**
 * What the client will accept as an error body.
 *
 * Deliberately looser than `errorEnvelopeSchema`, which requires `correlationId`: that is the
 * contract the *server* must meet, and holding a client to it would mean losing the one piece
 * of actionable information — the code — because a support id went missing in a proxy. The
 * code is what the UI branches on, so it is the only field required here.
 */
const errorBodySchema = z.object({
  code: errorCodeSchema,
  message: z.string().optional(),
  details: z.unknown().optional(),
  correlationId: z.string().optional(),
});

/** Not a server code: the request never reached one. */
export const NETWORK_ERROR = 'NETWORK';

export type MessageKey = ErrorCode | typeof NETWORK_ERROR;

/**
 * A failure the server described.
 *
 * The `code` is what the UI branches on — never the message. The message is prose the server
 * wrote for a log; the code is a contract, and it is the only part that can be relied on to
 * mean the same thing next release.
 */
export class ApiError extends Error {
  readonly code: MessageKey;
  readonly status: number;
  readonly details: unknown;
  readonly correlationId: string | undefined;
  /** Seconds to wait, from `Retry-After`, when the server said so. */
  readonly retryAfterSeconds: number | undefined;

  constructor(input: {
    code: MessageKey;
    status: number;
    message?: string;
    details?: unknown;
    correlationId?: string | undefined;
    retryAfterSeconds?: number | undefined;
  }) {
    super(input.message ?? input.code);
    this.name = 'ApiError';
    this.code = input.code;
    this.status = input.status;
    this.details = input.details;
    this.correlationId = input.correlationId;
    this.retryAfterSeconds = input.retryAfterSeconds;
  }
}

/**
 * Turn a failed response into an `ApiError`.
 *
 * A body that is not the documented envelope becomes `INTERNAL_ERROR`. That case is not
 * theoretical: a proxy 502 or an nginx timeout returns HTML, and parsing it as JSON is how a
 * frontend ends up showing "Unexpected token < in JSON" to a customer.
 *
 * An unrecognised code is also `INTERNAL_ERROR` rather than passed through, so a server that
 * starts emitting a code this build has no translation for cannot render an empty message.
 */
export async function toApiError(response: Response): Promise<ApiError> {
  const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
  const retryAfterSeconds = Number.isFinite(retryAfter) ? retryAfter : undefined;

  const fallback = new ApiError({
    code: 'INTERNAL_ERROR',
    status: response.status,
    message: `${String(response.status)} ${response.statusText}`,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  });

  let body: unknown;

  try {
    body = await response.json();
  } catch {
    return fallback;
  }

  const parsed = errorBodySchema.safeParse(body);
  // An unrecognised code fails `errorCodeSchema` and lands here, which is what stops a server
  // emitting a code this build has no translation for from rendering an empty message.
  if (!parsed.success) return fallback;

  return new ApiError({
    code: parsed.data.code,
    status: response.status,
    ...(parsed.data.message === undefined ? {} : { message: parsed.data.message }),
    details: parsed.data.details,
    correlationId: parsed.data.correlationId,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  });
}

/**
 * The translation key for a failure.
 *
 * Keyed by code, never by the server's message: the message is not translated, not stable, and
 * sometimes says more than a customer should see.
 */
export function messageKeyFor(error: unknown): `errors.${MessageKey}` {
  if (error instanceof ApiError) return `errors.${error.code}`;

  // A `TypeError` from `fetch` means the request never got an answer.
  return `errors.${NETWORK_ERROR}`;
}
