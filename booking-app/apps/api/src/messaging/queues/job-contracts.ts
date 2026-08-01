import { cuidSchema } from '@shape-and-flow/booking-contracts';
import { z } from 'zod';

import { AppError } from '../../common/errors/app-error.js';

/**
 * Queues, job names, and a validated payload schema for every one of them.
 *
 * These live in the API rather than in the shared contracts package, which is a
 * deliberate departure from the plan. Two reasons:
 *
 *  1. Nothing in the browser enqueues or consumes a job, so a browser-importable
 *     package is the wrong home for them.
 *  2. Tenant-scoped payloads must carry `organizationId`, which is exactly what
 *     the contracts package's guard test forbids. Keeping job contracts out of it
 *     preserves that guard at full strength instead of weakening it to a
 *     name-pattern heuristic.
 */

export const QUEUE = {
  BOOKING: 'booking',
  PAYMENT: 'payment',
  NOTIFICATION: 'notification',
  WEBHOOK: 'webhook',
  MAINTENANCE: 'maintenance',
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

/** Every queue, in declaration order. */
export const QUEUES: readonly QueueName[] = Object.values(QUEUE);

/**
 * Job names are the outbox `eventType` values too, so they are dotted and
 * past-tense where they describe something that happened.
 */
export const JOB = {
  BOOKING_EXPIRY_REQUESTED: 'booking.expiry_requested',
  BOOKING_CONFIRMED: 'booking.confirmed',
  BOOKING_CANCELED: 'booking.canceled',
  BOOKING_PAYMENT_FAILED: 'booking.payment_failed',
  BOOKING_RESCHEDULED: 'booking.rescheduled',

  REFUND_REQUESTED: 'refund.requested',
  REFUND_SUCCEEDED: 'refund.succeeded',

  NOTIFICATION_SEND: 'notification.send',
  REMINDER_SCHEDULE: 'reminder.schedule',
  REMINDER_SEND: 'reminder.send',

  STRIPE_EVENT: 'stripe.event',
  MESSAGING_EVENT: 'messaging.event',

  SWEEP_EXPIRED_RESERVATIONS: 'sweep.expired_reservations',
  SWEEP_STUCK_EXPIRING: 'sweep.stuck_expiring',
  SWEEP_OUTBOX: 'sweep.outbox',
  SWEEP_INBOX: 'sweep.inbox',
  SWEEP_NOTIFICATIONS: 'sweep.notifications',
  SWEEP_IDEMPOTENCY_KEYS: 'sweep.idempotency_keys',
  SWEEP_REMINDERS: 'sweep.reminders',
  SWEEP_RETENTION: 'sweep.retention',
} as const;

export type JobName = (typeof JOB)[keyof typeof JOB];

/**
 * Queues whose jobs always concern one organization.
 *
 * WEBHOOK and MAINTENANCE are deliberately excluded. A Stripe event arrives before
 * the tenant is known — it is correlated to a persisted row afterwards — and a
 * sweep is global by design. Requiring `organizationId` on those would force
 * callers to invent one, which is worse than not having it.
 */
export const TENANT_SCOPED_QUEUES: readonly QueueName[] = [
  QUEUE.BOOKING,
  QUEUE.PAYMENT,
  QUEUE.NOTIFICATION,
];

export const JOB_QUEUE: Record<JobName, QueueName> = {
  [JOB.BOOKING_EXPIRY_REQUESTED]: QUEUE.BOOKING,
  [JOB.BOOKING_CONFIRMED]: QUEUE.BOOKING,
  [JOB.BOOKING_CANCELED]: QUEUE.BOOKING,
  [JOB.BOOKING_PAYMENT_FAILED]: QUEUE.BOOKING,
  [JOB.BOOKING_RESCHEDULED]: QUEUE.BOOKING,

  [JOB.REFUND_REQUESTED]: QUEUE.PAYMENT,
  [JOB.REFUND_SUCCEEDED]: QUEUE.PAYMENT,

  [JOB.NOTIFICATION_SEND]: QUEUE.NOTIFICATION,
  [JOB.REMINDER_SCHEDULE]: QUEUE.NOTIFICATION,
  [JOB.REMINDER_SEND]: QUEUE.NOTIFICATION,

  [JOB.STRIPE_EVENT]: QUEUE.WEBHOOK,
  [JOB.MESSAGING_EVENT]: QUEUE.WEBHOOK,

  [JOB.SWEEP_EXPIRED_RESERVATIONS]: QUEUE.MAINTENANCE,
  [JOB.SWEEP_STUCK_EXPIRING]: QUEUE.MAINTENANCE,
  [JOB.SWEEP_OUTBOX]: QUEUE.MAINTENANCE,
  [JOB.SWEEP_INBOX]: QUEUE.MAINTENANCE,
  [JOB.SWEEP_NOTIFICATIONS]: QUEUE.MAINTENANCE,
  [JOB.SWEEP_IDEMPOTENCY_KEYS]: QUEUE.MAINTENANCE,
  [JOB.SWEEP_REMINDERS]: QUEUE.MAINTENANCE,
  [JOB.SWEEP_RETENTION]: QUEUE.MAINTENANCE,
};

/** Carried on every job so a worker log line ties back to the request. */
const correlationShape = { correlationId: z.string().optional() };

/** A job that always concerns one organization. */
const tenantJob = <Shape extends z.ZodRawShape>(shape: Shape) =>
  z.object({ ...correlationShape, organizationId: cuidSchema, ...shape }).strict();

/** A job with no tenant: an inbound webhook, or a global sweep. */
const globalJob = <Shape extends z.ZodRawShape>(shape: Shape) =>
  z.object({ ...correlationShape, ...shape }).strict();

const sweepJob = () => globalJob({});

export const jobPayloadSchemas = {
  [JOB.BOOKING_EXPIRY_REQUESTED]: tenantJob({ bookingId: cuidSchema }),
  /**
   * `managementToken` is the plaintext, carried so the confirmation email can
   * contain the link while the database stores only its hash. It is transient —
   * see the note in the progress document about the trade-off this makes — and it
   * is in the log redaction list.
   */
  [JOB.BOOKING_CONFIRMED]: tenantJob({
    bookingId: cuidSchema,
    managementToken: z.string().optional(),
  }),
  [JOB.BOOKING_CANCELED]: tenantJob({
    bookingId: cuidSchema,
    refundId: cuidSchema.optional(),
  }),
  [JOB.BOOKING_PAYMENT_FAILED]: tenantJob({ bookingId: cuidSchema }),
  [JOB.BOOKING_RESCHEDULED]: tenantJob({
    bookingId: cuidSchema,
    previousBookingId: cuidSchema,
  }),

  [JOB.REFUND_REQUESTED]: tenantJob({ refundId: cuidSchema }),
  [JOB.REFUND_SUCCEEDED]: tenantJob({ refundId: cuidSchema }),

  [JOB.NOTIFICATION_SEND]: tenantJob({ notificationId: cuidSchema }),
  [JOB.REMINDER_SCHEDULE]: tenantJob({ bookingId: cuidSchema }),
  /**
   * The appointment time is carried in the payload, not just in the job id, so the
   * processor can re-validate that the booking still starts when the reminder was
   * scheduled for and skip silently if it does not.
   */
  [JOB.REMINDER_SEND]: tenantJob({
    bookingId: cuidSchema,
    offsetMinutes: z.number().int().positive(),
    expectedStartsAtEpochSeconds: z.number().int().positive(),
  }),

  [JOB.STRIPE_EVENT]: globalJob({ stripeEventId: z.string().min(1) }),
  [JOB.MESSAGING_EVENT]: globalJob({
    provider: z.enum(['RESEND', 'TWILIO']),
    providerEventId: z.string().min(1),
  }),

  [JOB.SWEEP_EXPIRED_RESERVATIONS]: sweepJob(),
  [JOB.SWEEP_STUCK_EXPIRING]: sweepJob(),
  [JOB.SWEEP_OUTBOX]: sweepJob(),
  [JOB.SWEEP_INBOX]: sweepJob(),
  [JOB.SWEEP_NOTIFICATIONS]: sweepJob(),
  [JOB.SWEEP_IDEMPOTENCY_KEYS]: sweepJob(),
  [JOB.SWEEP_REMINDERS]: sweepJob(),
  [JOB.SWEEP_RETENTION]: sweepJob(),
} as const satisfies Record<JobName, z.ZodType>;

export type JobPayload<Name extends JobName> = z.infer<(typeof jobPayloadSchemas)[Name]>;

/** True when the string is a declared job name. */
export function isJobName(value: string): value is JobName {
  return Object.hasOwn(jobPayloadSchemas, value);
}

/**
 * Validate a payload against its job's schema.
 *
 * Called on the way out, by the enqueuer, and again on the way in, by the
 * processor router. Validating twice is cheap and means a malformed payload fails
 * at the boundary that produced it — naming the job — rather than deep inside a
 * processor with a stack trace that says nothing useful.
 */
export function parseJobPayload<Name extends JobName>(
  name: Name,
  payload: unknown,
): JobPayload<Name> {
  if (!isJobName(name)) {
    throw new AppError('UNKNOWN_JOB_NAME', {
      status: 500,
      message: `Unknown job name "${String(name)}". Declare it in JOB and JOB_QUEUE first.`,
    });
  }

  const result = jobPayloadSchemas[name].safeParse(payload);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');

    throw new AppError('INVALID_JOB_PAYLOAD', {
      status: 500,
      message: `Invalid payload for job "${name}" — ${issues}`,
      details: { job: name },
    });
  }

  return result.data as JobPayload<Name>;
}

/**
 * Reject a job id BullMQ would reject, at the boundary that produced it.
 *
 * BullMQ forbids two things in a custom id, both of them easy to trip over:
 *
 *  - a colon, because ids share a key namespace with everything else. It makes a
 *    narrow exception for a three-part id, but that exists only to keep old
 *    repeatable jobs working and its own source says it is going away — so this
 *    treats every colon as an error rather than building on it.
 *  - an id that parses as an integer, because those collide with the ids BullMQ
 *    generates itself.
 *
 * Failing here matters because the failure mode is silent otherwise: an outbox
 * dispatcher whose ids are rejected loses deduplication, and the symptom is
 * duplicate confirmation emails rather than an error anyone sees.
 */
export function assertValidJobId(jobId: string): void {
  const reason =
    jobId.length === 0
      ? 'must not be empty'
      : jobId.includes(':')
        ? 'must not contain ":" — BullMQ reserves it as a key separator'
        : String(Number.parseInt(jobId, 10)) === jobId
          ? 'must not be an integer — those collide with BullMQ-generated ids'
          : null;

  if (reason !== null) {
    throw new AppError('INVALID_JOB_ID', {
      status: 500,
      message: `Job id "${jobId}" ${reason}. Build ids with jobIdFor().`,
    });
  }
}

/**
 * Build a deduplication id from its parts.
 *
 * The one way to construct a job id, so the rules above are honoured by
 * construction: `jobIdFor('outbox', row.id)` rather than a template string that
 * happens to use a colon.
 */
export function jobIdFor(...parts: (string | number)[]): string {
  const jobId = parts.map(String).join('-');
  assertValidJobId(jobId);
  return jobId;
}

/** The queue a job belongs to. */
export function queueForJob(name: JobName): QueueName {
  // Read as possibly-undefined on purpose. The type says the lookup is total, but
  // a caller reaching this with a cast — a job name read from a Redis payload, say
  // — would otherwise get `undefined` and enqueue onto nothing.
  const queue = JOB_QUEUE[name] as QueueName | undefined;
  if (queue === undefined) {
    throw new AppError('UNKNOWN_JOB_NAME', {
      status: 500,
      message: `Job "${name}" has no queue. Add it to JOB_QUEUE.`,
    });
  }
  return queue;
}
