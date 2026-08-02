import { AppError } from '../common/errors/app-error.js';

import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';

/**
 * A webhook body is capped well below any plausible event, and far below what an
 * unauthenticated endpoint should be willing to buffer in memory.
 *
 * Nothing reads this yet. The cap the sentence above describes is not in force:
 * no body-parser limit is configured, so the webhook endpoints currently accept
 * whatever Express's default allows. Kept, and kept exported, so the intent
 * survives until it is wired into the parser rather than being quietly dropped
 * by a dead-code sweep.
 *
 * @knipignore
 */
export const WEBHOOK_BODY_LIMIT = '1mb';

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
  const { rawBody } = request;

  if (rawBody === undefined) {
    throw new AppError('INTERNAL_ERROR', {
      message:
        'Webhook received no raw body. The application must be created with { rawBody: true }.',
    });
  }

  return rawBody;
}
