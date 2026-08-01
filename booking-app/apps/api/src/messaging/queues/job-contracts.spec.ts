import { describe, expect, it } from 'vitest';

import {
  JOB,
  JOB_QUEUE,
  QUEUE,
  QUEUES,
  TENANT_SCOPED_QUEUES,
  assertValidJobId,
  isJobName,
  jobIdFor,
  jobPayloadSchemas,
  parseJobPayload,
  queueForJob,
} from './job-contracts.js';

import type { JobName } from './job-contracts.js';

/** A realistic cuid, so the schemas are exercised rather than bypassed. */
const ORG = 'cms9gryv30000ja32145w5gke';
const BOOKING = 'cms9gryvd0002ja32s1nvydb2';

const ALL_JOBS = Object.values(JOB);

describe('the registry is complete', () => {
  it('assigns every job to a declared queue', () => {
    for (const name of ALL_JOBS) {
      expect(JOB_QUEUE[name], name).toBeDefined();
      expect(QUEUES, name).toContain(JOB_QUEUE[name]);
    }
  });

  it('declares a payload schema for every job', () => {
    // A new job without a schema fails here rather than at the first enqueue.
    for (const name of ALL_JOBS) {
      expect(jobPayloadSchemas[name], name).toBeDefined();
    }
  });

  it('has no schema for a job that is not declared, and vice versa', () => {
    expect(Object.keys(jobPayloadSchemas).sort()).toEqual([...ALL_JOBS].sort());
    expect(Object.keys(JOB_QUEUE).sort()).toEqual([...ALL_JOBS].sort());
  });

  it('uses every declared queue, so none is dead weight', () => {
    const used = new Set(Object.values(JOB_QUEUE));
    for (const queue of QUEUES) {
      expect(used, queue).toContain(queue);
    }
  });

  it('names jobs consistently, since job names double as outbox event types', () => {
    for (const name of ALL_JOBS) {
      expect(name, name).toMatch(/^[a-z]+(\.[a-z_]+)+$/);
    }
  });
});

describe('tenant scoping', () => {
  it('requires organizationId on every job in a tenant-scoped queue', () => {
    for (const name of ALL_JOBS) {
      if (!TENANT_SCOPED_QUEUES.includes(JOB_QUEUE[name])) continue;

      // Without a tenant a processor cannot scope a single query, so this is not
      // optional for these queues.
      const result = jobPayloadSchemas[name].safeParse({ bookingId: BOOKING, refundId: BOOKING });
      expect(result.success, `${name} accepted a payload with no organizationId`).toBe(false);
    }
  });

  it('does not require organizationId on webhook or maintenance jobs', () => {
    // A Stripe event arrives before the tenant is known; a sweep is global by
    // design. Demanding an organizationId would force callers to invent one.
    expect(jobPayloadSchemas[JOB.STRIPE_EVENT].safeParse({ stripeEventId: 'evt_1' }).success).toBe(
      true,
    );
    expect(jobPayloadSchemas[JOB.SWEEP_OUTBOX].safeParse({}).success).toBe(true);
  });

  it('keeps webhook and maintenance out of the tenant-scoped list', () => {
    expect(TENANT_SCOPED_QUEUES).not.toContain(QUEUE.WEBHOOK);
    expect(TENANT_SCOPED_QUEUES).not.toContain(QUEUE.MAINTENANCE);
  });
});

describe('parseJobPayload', () => {
  it('accepts a well-formed payload and returns it typed', () => {
    const payload = parseJobPayload(JOB.BOOKING_CONFIRMED, {
      organizationId: ORG,
      bookingId: BOOKING,
    });
    expect(payload.bookingId).toBe(BOOKING);
  });

  it('rejects a payload missing organizationId, naming the job and the field', () => {
    expect(() => parseJobPayload(JOB.BOOKING_CONFIRMED, { bookingId: BOOKING })).toThrow(
      /booking\.confirmed.*organizationId/s,
    );
  });

  it('rejects an unknown job name rather than passing it through', () => {
    expect(() => parseJobPayload('nope.not_a_job' as JobName, {})).toThrow(/Unknown job name/);
  });

  it('rejects an unexpected extra field', () => {
    // Strict objects: a typo in a payload key is a bug, not a field to ignore.
    expect(() =>
      parseJobPayload(JOB.BOOKING_CONFIRMED, {
        organizationId: ORG,
        bookingId: BOOKING,
        bookignId: BOOKING,
      }),
    ).toThrow(/booking\.confirmed/);
  });

  it('rejects a malformed id rather than letting it reach a query', () => {
    expect(() =>
      parseJobPayload(JOB.BOOKING_CONFIRMED, { organizationId: ORG, bookingId: 'nope' }),
    ).toThrow(/bookingId/);
  });

  it('accepts an optional correlation id on any job', () => {
    expect(parseJobPayload(JOB.SWEEP_OUTBOX, { correlationId: 'corr-1' }).correlationId).toBe(
      'corr-1',
    );
  });

  it('requires the reminder payload to carry the appointment time', () => {
    // The processor re-validates against this before sending, so a rescheduled
    // booking does not get a stale reminder.
    expect(() =>
      parseJobPayload(JOB.REMINDER_SEND, {
        organizationId: ORG,
        bookingId: BOOKING,
        offsetMinutes: 1440,
      }),
    ).toThrow(/expectedStartsAtEpochSeconds/);

    expect(
      parseJobPayload(JOB.REMINDER_SEND, {
        organizationId: ORG,
        bookingId: BOOKING,
        offsetMinutes: 1440,
        expectedStartsAtEpochSeconds: 1_786_000_000,
      }).offsetMinutes,
    ).toBe(1440);
  });

  it('restricts the messaging provider to the two that exist', () => {
    expect(
      jobPayloadSchemas[JOB.MESSAGING_EVENT].safeParse({
        provider: 'RESEND',
        providerEventId: 'e1',
      }).success,
    ).toBe(true);
    expect(
      jobPayloadSchemas[JOB.MESSAGING_EVENT].safeParse({
        provider: 'POSTMARK',
        providerEventId: 'e1',
      }).success,
    ).toBe(false);
  });
});

describe('job ids', () => {
  it('joins parts with a separator BullMQ accepts', () => {
    expect(jobIdFor('outbox', BOOKING)).toBe(`outbox-${BOOKING}`);
    expect(jobIdFor('reminder', BOOKING, 1440)).toBe(`reminder-${BOOKING}-1440`);
  });

  it('rejects a colon, which BullMQ reserves as a key separator', () => {
    expect(() => jobIdFor('outbox:1')).toThrow(/must not contain ":"/);
    // Three-part ids are accepted by BullMQ today only to keep old repeatable jobs
    // working, and its own source says that is going away. Rejected here too.
    expect(() => {
      assertValidJobId('a:b:c');
    }).toThrow(/must not contain ":"/);
  });

  it('rejects an integer id, which would collide with a generated one', () => {
    expect(() => jobIdFor(42)).toThrow(/must not be an integer/);
    expect(() => {
      assertValidJobId('-7');
    }).toThrow(/must not be an integer/);
    // Not an integer once it has a prefix, which is the normal case.
    expect(jobIdFor('outbox', 42)).toBe('outbox-42');
  });

  it('rejects an empty id', () => {
    expect(() => {
      assertValidJobId('');
    }).toThrow(/must not be empty/);
  });

  it('accepts a cuid, which is what every real id is built from', () => {
    expect(() => {
      assertValidJobId(BOOKING);
    }).not.toThrow();
  });
});

describe('isJobName and queueForJob', () => {
  it('recognises declared names only', () => {
    expect(isJobName('booking.confirmed')).toBe(true);
    expect(isJobName('booking.definitely_not')).toBe(false);
    expect(isJobName('')).toBe(false);
  });

  it('resolves the queue for every job', () => {
    for (const name of ALL_JOBS) {
      expect(QUEUES, name).toContain(queueForJob(name));
    }
  });

  it('routes each family to the queue a reader would expect', () => {
    expect(queueForJob(JOB.BOOKING_CONFIRMED)).toBe(QUEUE.BOOKING);
    expect(queueForJob(JOB.REFUND_REQUESTED)).toBe(QUEUE.PAYMENT);
    expect(queueForJob(JOB.NOTIFICATION_SEND)).toBe(QUEUE.NOTIFICATION);
    expect(queueForJob(JOB.STRIPE_EVENT)).toBe(QUEUE.WEBHOOK);
    expect(queueForJob(JOB.SWEEP_RETENTION)).toBe(QUEUE.MAINTENANCE);
  });
});
