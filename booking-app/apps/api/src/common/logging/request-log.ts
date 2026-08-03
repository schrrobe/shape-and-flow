import { correlationId } from '../correlation/correlation.store.js';

/**
 * The one line per request.
 *
 * The plan asks for a Nest interceptor. It is pino-http's automatic request log
 * instead, configured here, because an interceptor cannot see the requests that
 * matter most in an incident: guards run *before* interceptors, so every 401, 403
 * and 429 — and every 404, which never reaches a handler at all — would be missing
 * from the log. pino-http logs on the response's `finish` event, which happens for
 * all of them. Keeping both would mean two lines per request and one of them
 * incomplete.
 *
 * The pieces are separated out here so they can be tested as what they are:
 * decisions about level, sampling and shape, rather than logger configuration.
 */

/** What a probe's URL starts with. Never logged: it would drown everything else. */
const HEALTH_PREFIX = '/api/health';

/**
 * The one endpoint that can dominate log volume on its own.
 *
 * A customer browsing a calendar issues one of these per date change, and none of
 * them is what an investigation starts from. Everything else is logged in full,
 * because a sampled-out booking or webhook is a hole in the story exactly where it
 * is needed.
 */
const SAMPLED_PREFIX = '/api/public/availability';

export type RequestLogLevel = 'info' | 'warn' | 'error';

/**
 * Level by outcome.
 *
 * The same rule the exception filter applies to what it logs: a rejected request is
 * ordinary and a failed one is not, so a search for `level >= error` finds the
 * incidents and nothing else.
 */
export function requestLogLevel(status: number, error?: Error): RequestLogLevel {
  if (error !== undefined || status >= 500) return 'error';
  if (status >= 400) return 'warn';
  return 'info';
}

/**
 * Whether this request's line is dropped before it is written.
 *
 * `random` is a parameter so the decision is testable; production passes
 * `Math.random`.
 */
export function shouldSkipRequestLog(
  url: string | undefined,
  sampleRate: number,
  random: () => number = Math.random,
): boolean {
  const path = url ?? '';

  if (path.startsWith(HEALTH_PREFIX)) return true;
  if (!path.startsWith(SAMPLED_PREFIX)) return false;

  return random() >= sampleRate;
}

/**
 * What is kept of the request object.
 *
 * pino-http's default serializer logs every header. The redaction list covers the
 * ones that carry a credential *inbound*, but the useful content of a request line
 * is five fields, and fifteen security headers per line is log volume nobody reads.
 * The user agent survives because "only Safari sees this" is a real diagnosis.
 */
export function serializeRequest(request: {
  id?: unknown;
  method?: string;
  url?: string;
  remoteAddress?: string;
  headers?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    id: request.id,
    method: request.method,
    url: request.url,
    remoteAddress: request.remoteAddress,
    userAgent: request.headers?.['user-agent'],
  };
}

/**
 * What is kept of the response object: the status, and nothing else.
 *
 * The default serializer emits the response headers, and on the office login route
 * those contain `Set-Cookie` — a live session id. No redaction path covered it,
 * because the list was written for request headers. Not logging them at all is the
 * fix that cannot be forgotten the next time a route sets a header.
 */
export function serializeResponse(response: { statusCode: number }): Record<string, unknown> {
  return { statusCode: response.statusCode };
}

/**
 * The fields every line of a request is searched by.
 *
 * Top-level rather than nested inside pino-http's `req` object: an operator filtering
 * a log shipper writes `url = "/api/public/bookings"`, not `req.url = …`, and the
 * correlation id has to sit beside them to be usable as the join key.
 *
 * The status is deliberately absent. These props decorate *every* line logged during
 * the request — the exception filter's included — and while a handler is still
 * running `res.statusCode` is Node's default 200, so a line about a 401 would say
 * `statusCode: 200`. {@link requestOutcomeProps} adds it to the one line that knows.
 */
export function requestLogProps(request: {
  method?: string | undefined;
  url?: string | undefined;
}): { method: string; url: string; correlationId: string } {
  return {
    method: request.method ?? '-',
    url: request.url ?? '-',
    correlationId: correlationId(),
  };
}

/** Added to the line that completes a request, which is where the status is real. */
export function requestOutcomeProps(response: { statusCode: number }): { statusCode: number } {
  return { statusCode: response.statusCode };
}
