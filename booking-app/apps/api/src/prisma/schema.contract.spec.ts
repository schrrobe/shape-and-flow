import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * Asserts the invariants the schema is supposed to hold, against the schema
 * text itself. These are cheap, and each one has a specific failure mode it
 * exists to catch — a model added without organization scoping, a naive
 * timestamp, a float amount, or a cascade that could reach a money row.
 */

const schema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');

const EXPECTED_MODELS = [
  'Organization',
  'OrganizationSettings',
  'OrganizationDomain',
  'ClosedDay',
  'OfficeUser',
  'PasswordResetToken',
  'Employee',
  'WorkingHours',
  'Break',
  'AvailabilityException',
  'TimeOff',
  'BlockedTime',
  'ServiceCategory',
  'Service',
  'EmployeeService',
  'Customer',
  'Booking',
  'BookingStatusHistory',
  'ManagementToken',
  'Payment',
  'ManualPayment',
  'Refund',
  'CancellationRequest',
  'RescheduleRequest',
  'Notification',
  'OutboxEvent',
  'IdempotencyKey',
  'StripeWebhookEvent',
  'MessagingWebhookEvent',
  'AuditLog',
];

/** The tenant root itself carries no organizationId. */
const UNSCOPED = new Set(['Organization']);

/**
 * Rows that can legitimately arrive before the tenant is known, so their
 * organizationId is nullable and backfilled.
 */
const OPTIONAL_SCOPE = new Set(['IdempotencyKey', 'StripeWebhookEvent', 'MessagingWebhookEvent']);

/** Money must never be reachable by a cascading delete. */
const MONEY_MODELS = ['Payment', 'ManualPayment', 'Refund'];

const modelNames = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((match) => match[1] ?? '');

function bodyOf(model: string): string {
  const match = new RegExp(String.raw`^model\s+${model}\s*\{([\s\S]*?)^\}`, 'm').exec(schema);
  if (!match?.[1]) throw new Error(`model ${model} not found in schema.prisma`);
  return match[1];
}

/** Field lines only: skips comments, blank lines, and block attributes. */
function fieldLines(body: string): string[] {
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('//') && !line.startsWith('@@'));
}

describe('schema.prisma models', () => {
  it('declares exactly the thirty planned models', () => {
    expect([...modelNames].sort()).toEqual([...EXPECTED_MODELS].sort());
  });

  it('declares thirty models, not merely the right names', () => {
    expect(modelNames).toHaveLength(30);
  });
});

describe('organization scoping', () => {
  it('scopes every scoped model by organizationId', () => {
    for (const model of modelNames) {
      if (UNSCOPED.has(model)) continue;
      expect(bodyOf(model), `${model} is missing organizationId`).toMatch(
        /organizationId\s+String/,
      );
    }
  });

  it('makes organizationId nullable on exactly the three documented models', () => {
    const nullable = modelNames.filter((model) => /organizationId\s+String\?/.test(bodyOf(model)));
    expect([...nullable].sort()).toEqual([...OPTIONAL_SCOPE].sort());
  });

  it('leads a composite index with organizationId on the hot booking paths', () => {
    const booking = bodyOf('Booking');
    expect(booking).toContain('@@index([organizationId, employeeId, blockStartsAt])');
    expect(booking).toContain('@@index([organizationId, status, startsAt])');
    // The expiry sweeper's only scan.
    expect(booking).toContain('@@index([status, expiresAt])');
  });
});

describe('time columns', () => {
  it('stores every instant as timestamptz and every date-only value as date', () => {
    const offenders: string[] = [];

    for (const model of modelNames) {
      for (const line of fieldLines(bodyOf(model))) {
        if (!/^\w+\s+DateTime\??(\s|$)/.test(line)) continue;
        if (!line.includes('@db.Timestamptz(3)') && !line.includes('@db.Date')) {
          offenders.push(`${model}: ${line}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe('money columns', () => {
  it('types every cents column as Int', () => {
    const offenders: string[] = [];

    for (const model of modelNames) {
      for (const line of fieldLines(bodyOf(model))) {
        const match = /^(\w*Cents)\s+(\S+)/.exec(line);
        if (match && match[2] !== 'Int' && match[2] !== 'Int?') {
          offenders.push(`${model}.${match[1] ?? ''}: ${match[2] ?? ''}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('uses no Float or Decimal anywhere', () => {
    expect(schema).not.toMatch(/^\s*\w+\s+(Float|Decimal)\b/m);
  });

  it('never lets a cascade reach a money table', () => {
    for (const model of MONEY_MODELS) {
      expect(bodyOf(model), `${model} is cascade-reachable`).not.toContain('onDelete: Cascade');
    }
  });

  it('attaches money to its booking with Restrict, so a booking cannot be deleted', () => {
    for (const model of MONEY_MODELS) {
      expect(bodyOf(model)).toMatch(/booking\s+Booking\s+@relation\([^)]*onDelete: Restrict/);
    }
  });
});

describe('booking invariants', () => {
  it('makes every exclusion-constraint column non-nullable', () => {
    const booking = bodyOf('Booking');
    for (const column of ['organizationId', 'employeeId', 'blockStartsAt', 'blockEndsAt']) {
      const line = fieldLines(booking).find((candidate) => candidate.startsWith(`${column} `));
      expect(line, `${column} not found`).toBeDefined();
      const type = /^\w+\s+(\S+)/.exec(line ?? '')?.[1];
      expect(type, `${column} must be NOT NULL for the exclusion constraint`).not.toMatch(/\?$/);
    }
  });

  it('keeps the reservation on the booking row rather than a separate entity', () => {
    const booking = bodyOf('Booking');
    expect(booking).toMatch(/expiresAt\s+DateTime\?/);
    expect(booking).toMatch(/stripeCheckoutSessionId\s+String\?\s+@unique/);
    expect(booking).toMatch(/idempotencyKeyId\s+String\?\s+@unique/);
    expect(modelNames).not.toContain('BookingReservation');
  });

  it('persists EXPIRING as a real status', () => {
    const statusEnum = /enum BookingStatus \{([\s\S]*?)\}/.exec(schema)?.[1] ?? '';
    expect(statusEnum).toContain('EXPIRING');
    expect(statusEnum).toContain('EXPIRED');
  });

  it('does not persist the derived display statuses', () => {
    const statusEnum = /enum BookingStatus \{([\s\S]*?)\}/.exec(schema)?.[1] ?? '';
    expect(statusEnum).not.toContain('CANCELLATION_REQUESTED');
    expect(statusEnum).not.toContain('RESCHEDULE_REQUESTED');
  });
});

describe('physical naming', () => {
  it('maps every model to a snake_case table', () => {
    for (const model of modelNames) {
      expect(bodyOf(model), `${model} has no @@map`).toMatch(/@@map\("[a-z0-9_]+"\)/);
    }
  });
});
