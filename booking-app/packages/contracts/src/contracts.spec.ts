import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import { ZodObject, z } from 'zod';

import { ERROR_STATUS, errorCodeSchema, isPublicErrorCode } from './errors.js';
import { blockedTimeListQuerySchema, closedDayListQuerySchema } from './office/staff.js';
import { cursorPageSchema, cursorQuerySchema } from './pagination.js';
import { boundedInt, localDateSchema, moneySchema } from './primitives.js';

import * as contracts from './index.js';

describe('no request contract accepts organizationId', () => {
  it('holds for every exported object schema', () => {
    // The third of three layers enforcing server-side tenant resolution,
    // alongside the Prisma guard and the two-organization integration tests.
    // A developer who adds organizationId to a request body gets a red test
    // naming the schema, rather than a data leak.
    const offenders: string[] = [];

    for (const [name, value] of Object.entries(contracts)) {
      if (!(value instanceof ZodObject)) continue;
      if (Object.hasOwn(value.shape, 'organizationId')) offenders.push(name);
    }

    expect(offenders).toEqual([]);
  });

  it('is not vacuous — there are object schemas to check', () => {
    const objectSchemas = Object.values(contracts).filter((value) => value instanceof ZodObject);
    expect(objectSchemas.length).toBeGreaterThan(0);
  });
});

describe('error codes', () => {
  it('maps every code to a status, and every status entry to a code', () => {
    expect([...errorCodeSchema.options].sort()).toEqual(Object.keys(ERROR_STATUS).sort());
  });

  it('uses only plausible HTTP statuses', () => {
    for (const [code, status] of Object.entries(ERROR_STATUS)) {
      expect(status, code).toBeGreaterThanOrEqual(400);
      expect(status, code).toBeLessThan(600);
    }
  });

  it('recognises public codes and rejects internal ones', () => {
    expect(isPublicErrorCode('SLOT_UNAVAILABLE')).toBe(true);
    // Internal invariant violations are deliberately absent, so the exception
    // filter turns them into a generic 500 instead of leaking them.
    expect(isPublicErrorCode('INVALID_MONEY')).toBe(false);
    expect(isPublicErrorCode('UNSCOPED_TENANT_QUERY')).toBe(false);
    expect(isPublicErrorCode('')).toBe(false);
  });

  it('keeps SLOT_UNAVAILABLE a 409 and IDEMPOTENCY_KEY_REUSED a 422', () => {
    // Both are relied on by the public booking flow and by its tests.
    expect(ERROR_STATUS.SLOT_UNAVAILABLE).toBe(409);
    expect(ERROR_STATUS.IDEMPOTENCY_KEY_REUSED).toBe(422);
    expect(ERROR_STATUS.NOT_FOUND).toBe(404);
  });
});

describe('primitives', () => {
  it('accepts money as integer cents and rejects a float or a bad currency', () => {
    expect(moneySchema.safeParse({ amountCents: 4500, currency: 'EUR' }).success).toBe(true);
    expect(moneySchema.safeParse({ amountCents: -4500, currency: 'EUR' }).success).toBe(true);
    expect(moneySchema.safeParse({ amountCents: 45.5, currency: 'EUR' }).success).toBe(false);
    expect(moneySchema.safeParse({ amountCents: 4500, currency: 'EURO' }).success).toBe(false);
  });

  it('accepts a real local date and rejects a malformed or impossible one', () => {
    expect(localDateSchema.safeParse('2026-08-14').success).toBe(true);
    expect(localDateSchema.safeParse('2026-02-29').success).toBe(false); // 2026 is not a leap year
    expect(localDateSchema.safeParse('2026-02-30').success).toBe(false);
    expect(localDateSchema.safeParse('2026-13-01').success).toBe(false);
    expect(localDateSchema.safeParse('14-08-2026').success).toBe(false);
    expect(localDateSchema.safeParse('2026-8-14').success).toBe(false);
  });

  it('accepts a leap day in a leap year', () => {
    expect(localDateSchema.safeParse('2028-02-29').success).toBe(true);
  });

  it('requires the idempotency key to be a uuid', () => {
    expect(contracts.idempotencyKeySchema.safeParse(randomUUID()).success).toBe(true);
    expect(contracts.idempotencyKeySchema.safeParse('anna@example.com').success).toBe(false);
  });

  it('builds a reusable bounded integer schema', () => {
    const schema = boundedInt({ min: 2, max: 4 });

    expect(schema.safeParse(2).success).toBe(true);
    expect(schema.safeParse(4).success).toBe(true);
    expect(schema.safeParse(1).success).toBe(false);
    expect(schema.safeParse(5).success).toBe(false);
    expect(schema.safeParse(2.5).success).toBe(false);
  });
});

describe('office list ranges', () => {
  it.each([blockedTimeListQuerySchema, closedDayListQuerySchema])(
    'rejects inverted and longer-than-calendar ranges',
    (schema) => {
      expect(schema.safeParse({ from: '2026-03-02', to: '2026-03-01' }).success).toBe(false);
      expect(schema.safeParse({ from: '2026-01-01', to: '2026-03-04' }).success).toBe(false);
      expect(schema.safeParse({ from: '2026-01-01', to: '2026-03-03' }).success).toBe(true);
    },
  );
});

describe('pagination', () => {
  it('defaults the limit and caps it', () => {
    expect(cursorQuerySchema.parse({}).limit).toBe(25);
    expect(cursorQuerySchema.parse({ limit: '10' }).limit).toBe(10);
    expect(cursorQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(cursorQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
  });

  it('builds a page schema whose cursor is nullable, not optional', () => {
    const page = cursorPageSchema(z.object({ id: z.string() }));
    expect(page.safeParse({ items: [], nextCursor: null }).success).toBe(true);
    expect(page.safeParse({ items: [{ id: 'a' }], nextCursor: 'abc' }).success).toBe(true);
    // Absent is not the same as "no more pages"; the field must be explicit.
    expect(page.safeParse({ items: [] }).success).toBe(false);
  });
});

describe('enums', () => {
  it('derives display statuses from booking statuses plus the two request states', () => {
    for (const status of contracts.bookingStatusSchema.options) {
      expect(contracts.displayStatusSchema.options).toContain(status);
    }
    expect(contracts.displayStatusSchema.options).toContain('CANCELLATION_REQUESTED');
    expect(contracts.displayStatusSchema.options).toContain('RESCHEDULE_REQUESTED');
  });

  it('does not persist the derived statuses as booking statuses', () => {
    expect(contracts.bookingStatusSchema.options).not.toContain('CANCELLATION_REQUESTED');
    expect(contracts.bookingStatusSchema.options).not.toContain('RESCHEDULE_REQUESTED');
  });

  it('keeps EXPIRING, which is what holds a slot during the Stripe round trip', () => {
    expect(contracts.bookingStatusSchema.options).toContain('EXPIRING');
  });
});
