import { newCorrelationId, runWithCorrelation } from './correlation.store.js';

import type { NextFunction, Request, Response } from 'express';

export const CORRELATION_HEADER = 'x-request-id';

/**
 * Opens a correlation scope for every request and echoes the id back.
 *
 * A plain Express handler registered with `app.use()` rather than a Nest
 * middleware, deliberately: Express middleware runs before anything a module
 * registers, which includes pino's request logger. If this ran second, `genReqId`
 * would find no scope and every request log would carry a placeholder instead of
 * an id.
 *
 * An inbound `X-Request-Id` is honoured so a reverse proxy or a client can tie its
 * own logs to ours. It is length-capped and restricted to printable ASCII: the
 * value lands in log lines and outbox rows, and an unbounded header is an easy way
 * to make logs unreadable or expensive.
 */
export function correlationMiddleware(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const id = sanitiseInboundId(request.headers[CORRELATION_HEADER]) ?? newCorrelationId();

  response.setHeader(CORRELATION_HEADER, id);

  runWithCorrelation(id, () => {
    next();
  });
}

function sanitiseInboundId(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== 'string') return null;

  const trimmed = raw.trim().slice(0, 128);
  if (trimmed === '') return null;

  return /^[\x20-\x7e]+$/.test(trimmed) ? trimmed : null;
}
