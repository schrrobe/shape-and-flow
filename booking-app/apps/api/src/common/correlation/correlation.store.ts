import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * One id per request, and per job, carried without threading it through every
 * signature.
 *
 * It reaches every log line, every outbox row and every error envelope, so an
 * incident can be traced from a customer's screenshot through the HTTP handler
 * into the worker that ran the consequences.
 *
 * The plan specified a ULID for its lexicographic time ordering. A UUID v4 is used
 * instead: it needs no dependency, `crypto.randomUUID` is native, and log ordering
 * comes from timestamps anyway. If sortable ids ever earn their keep, this is the
 * only place that changes.
 */
interface CorrelationContext {
  correlationId: string;
}

const storage = new AsyncLocalStorage<CorrelationContext>();

export function newCorrelationId(): string {
  return randomUUID();
}

/** Run `fn` inside a correlation scope. */
export function runWithCorrelation<T>(correlationId: string, fn: () => T): T {
  return storage.run({ correlationId }, fn);
}

/**
 * The current correlation id, or `'-'` outside any scope.
 *
 * Returning a placeholder rather than throwing is deliberate: a logger must never
 * be the thing that fails a request, and a bootstrap-time log line legitimately
 * has no request to belong to.
 */
export function correlationId(): string {
  return storage.getStore()?.correlationId ?? '-';
}

/** True when a correlation scope is active, for assertions and diagnostics. */
export function hasCorrelation(): boolean {
  return storage.getStore() !== undefined;
}
