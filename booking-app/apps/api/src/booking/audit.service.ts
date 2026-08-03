import { Injectable } from '@nestjs/common';

import { correlationId, hasCorrelation } from '../common/correlation/correlation.store.js';
import { REDACT_PATHS } from '../common/logging/redaction.js';

import type { AuditAction, Prisma } from '../prisma/client.js';

/** Field names the audit trail must not store, derived from the log redaction list. */
const REDACTED_FIELDS = new Set(REDACT_PATHS.map(lastField));

/**
 * The field a redaction path ends in.
 *
 * Bracket keys are parsed rather than had their punctuation stripped. Removing the brackets
 * from `req.headers["idempotency-key"]` and then taking the last dotted segment produced
 * `headersidempotency-key` — a name no object has — so the value that path exists to protect
 * was written to the audit trail in the clear. The bracket contents *are* the field name.
 */
function lastField(path: string): string {
  const bracketed = /\[\s*"?([^"\]]+)"?\s*\]\s*$/.exec(path);
  if (bracketed?.[1] !== undefined) return bracketed[1];

  return path.split('.').pop() ?? path;
}

/** What the censored value is replaced with, matching the logger. */
const CENSOR = '[Redacted]';

export interface AuditEntry {
  organizationId: string;
  /** Absent for a system action, which is a real distinction the office cares about. */
  officeUserId?: string | undefined;
  action: AuditAction;
  entityType: string;
  entityId: string;
  summary: string;
  before?: unknown;
  after?: unknown;
}

/**
 * Records who did what, in the transaction that did it.
 *
 * Taking the transaction client is the whole design: an audit row written outside the
 * change it describes can exist for a change that rolled back, or be missing for one
 * that committed. Neither is acceptable in a trail somebody may have to rely on.
 *
 * `before` and `after` pass through the same redaction list as the logger. An audit
 * trail is read by more people than a log — support staff, an owner reviewing a
 * dispute — so it is the last place a customer's phone number or a token should
 * accumulate.
 */
@Injectable()
export class AuditService {
  async record(tx: Prisma.TransactionClient, entry: AuditEntry): Promise<void> {
    await tx.auditLog.create({
      data: {
        organizationId: entry.organizationId,
        ...(entry.officeUserId === undefined ? {} : { officeUserId: entry.officeUserId }),
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        summary: entry.summary,
        ...(entry.before === undefined ? {} : { before: redact(entry.before) }),
        ...(entry.after === undefined ? {} : { after: redact(entry.after) }),
        // Stamped so an audit row can be joined to the request that produced it, and to
        // every log line from the same request.
        ...(hasCorrelation() ? { correlationId: correlationId() } : {}),
      },
      select: { id: true },
    });
  }
}

/** Replace sensitive values, recursively, leaving structure intact. */
function redact(value: unknown): Prisma.InputJsonValue {
  if (Array.isArray(value)) return value.map(redact);

  // Before the object branch, because `typeof new Date() === 'object'` and
  // `Object.entries(new Date())` is empty — a Date would be stored as `{}`. No caller passes
  // one today; this service is a shared helper and the next one will, silently.
  if (value instanceof Date) return value.toISOString();

  if (value === null || typeof value !== 'object') {
    return (value ?? null) as Prisma.InputJsonValue;
  }

  const result: Record<string, Prisma.InputJsonValue> = {};

  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = REDACTED_FIELDS.has(key) ? CENSOR : redact(item);
  }

  return result;
}
