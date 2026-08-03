import { PayloadTooLargeException } from '@nestjs/common';
import { raw } from 'express';

import { AppError } from '../common/errors/app-error.js';

import type { RawBodyRequest } from '@nestjs/common';
import type { Request, RequestHandler } from 'express';

/**
 * A webhook body is capped well below any plausible event, and far below what an
 * unauthenticated endpoint should be willing to buffer in memory.
 *
 * The parser below is mounted on the webhook route before Nest registers its global
 * JSON and form parsers, so the limit is enforced while the bytes are buffered.
 */
const WEBHOOK_BODY_LIMIT = '1mb';

const parseWebhookBody = raw({
  limit: WEBHOOK_BODY_LIMIT,
  type: ['application/json', 'application/x-www-form-urlencoded'],
});

/**
 * Buffer a webhook exactly once, with a route-specific upper bound.
 *
 * Providers use JSON (Stripe and Resend) or form encoding (Twilio), but every signature
 * covers the bytes rather than the parsed value. Mounting one raw parser for both media
 * types gives the controllers the same contract and prevents Nest's later global parser
 * from consuming the stream first.
 */
export const webhookBodyParser: RequestHandler = (request, response, next) => {
  parseWebhookBody(request, response, (error: unknown) => {
    next(isEntityTooLarge(error) ? new PayloadTooLargeException() : error);
  });
};

/**
 * The exact bytes the provider sent.
 *
 * A signature is computed over those bytes. Parsing the JSON and re-serialising it
 * changes them — key order, whitespace, number formatting — and the signature no longer
 * verifies.
 *
 * Nest's `rawBody: true` is what makes this available: it keeps the buffer aside while
 * still parsing JSON normally for every route. The alternative, a raw-body parser
 * mounted on the webhook path, does not work here — the global JSON parser runs before
 * module middleware and has already consumed the stream by then, so the raw parser sees
 * a parsed body and skips. That failure is silent, which is what makes it worth naming.
 */
export function rawBodyOf(request: RawBodyRequest<Request>): Buffer {
  const parsedBody = (request as unknown as { body?: unknown }).body;
  const rawBody = request.rawBody ?? (Buffer.isBuffer(parsedBody) ? parsedBody : undefined);

  if (rawBody === undefined) {
    throw new AppError('INTERNAL_ERROR', {
      message:
        'Webhook received no raw body. The application must be created with { rawBody: true }.',
    });
  }

  return rawBody;
}

function isEntityTooLarge(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    error.type === 'entity.too.large'
  );
}
