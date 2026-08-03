import { Inject, Injectable, Logger } from '@nestjs/common';
import { Worker } from 'bullmq';

import { ExpirySweeper } from '../../booking/expiry.sweeper.js';
import { ExpiryProcessor } from '../../booking/processors/expiry.processor.js';
import { StripeEventProcessor } from '../../booking/processors/stripe-event.processor.js';
import { AuditRetentionService } from '../../common/audit/audit-retention.service.js';
import {
  correlationId,
  newCorrelationId,
  runWithCorrelation,
} from '../../common/correlation/correlation.store.js';
import { ENV } from '../../config/env.schema.js';
import { NotificationReconciler } from '../../notification/notification.reconciler.js';
import { BookingEventProcessor } from '../../notification/processors/booking-event.processor.js';
import { MessagingEventProcessor } from '../../notification/processors/messaging-event.processor.js';
import { NotificationSendProcessor } from '../../notification/processors/notification-send.processor.js';
import { ReminderProcessor } from '../../notification/processors/reminder.processor.js';
import { ReminderReconciler } from '../../notification/reminder.reconciler.js';
import { OrganizationContextService } from '../../organization/organization-context.service.js';
import { RefundProcessor } from '../../payment/processors/refund.processor.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { InboxReconciler } from '../inbox/inbox.reconciler.js';
import { OutboxReconciler } from '../outbox/outbox.reconciler.js';

import { JOB, QUEUES, isJobName, parseJobPayload, queueForJob } from './job-contracts.js';
import { createRedisConnection } from './redis.provider.js';

import type { JobName, JobPayload, QueueName } from './job-contracts.js';
import type { AppConfig } from '../../config/env.schema.js';
import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';

/**
 * How long `close()` may take before the process gives up on a graceful stop.
 *
 * Long enough for a Stripe call or an email send to finish, short enough that a supervisor
 * does not decide the container is wedged and SIGKILL it mid-write.
 */
export const WORKER_DRAIN_TIMEOUT_MS = 30_000;

/** A handler for one job name, taking that job's validated payload. */
type Handler<Name extends JobName> = (payload: JobPayload<Name>) => Promise<void>;

/** The whole routing table, one entry per declared job name. */
type Routes = { [Name in JobName]: Handler<Name> };

/**
 * Runs jobs.
 *
 * One BullMQ `Worker` per queue, each with its own Redis connection. Not the shared client
 * the queues use: a worker's fetch is a blocking `BZPOPMIN`, and a blocking command on a
 * shared connection stalls every other command issued on it — including the enqueues a
 * processor makes while running.
 *
 * The routing table is exhaustive by type. `Routes` is mapped over `JobName`, so declaring a
 * job in `job-contracts.ts` and forgetting to handle it here is a compile error rather than
 * a job that sits in the queue until somebody notices the backlog.
 */
@Injectable()
export class WorkerRegistrarService {
  private readonly logger = new Logger('WorkerRegistrar');
  private readonly workers = new Map<QueueName, Worker>();
  private readonly connections: Redis[] = [];
  private readonly routes: Routes;

  constructor(
    @Inject(ENV) private readonly config: AppConfig,
    private readonly organizations: OrganizationContextService,
    expiry: ExpiryProcessor,
    sweeper: ExpirySweeper,
    stripe: StripeEventProcessor,
    refunds: RefundProcessor,
    bookingEvents: BookingEventProcessor,
    notificationSend: NotificationSendProcessor,
    messagingEvents: MessagingEventProcessor,
    reminders: ReminderProcessor,
    outbox: OutboxReconciler,
    inbox: InboxReconciler,
    notifications: NotificationReconciler,
    reminderReconciler: ReminderReconciler,
    idempotency: IdempotencyService,
    auditRetention: AuditRetentionService,
  ) {
    this.routes = {
      [JOB.BOOKING_EXPIRY_REQUESTED]: (payload) => expiry.handle(payload),
      [JOB.BOOKING_CONFIRMED]: (payload) => bookingEvents.confirmed(payload),
      [JOB.BOOKING_CANCELED]: (payload) => bookingEvents.canceled(payload),
      [JOB.BOOKING_PAYMENT_FAILED]: (payload) => bookingEvents.paymentFailed(payload),
      [JOB.BOOKING_RESCHEDULED]: (payload) => bookingEvents.rescheduled(payload),
      [JOB.REFUND_REQUESTED]: (payload) => refunds.handle(payload),
      [JOB.REFUND_SUCCEEDED]: (payload) => bookingEvents.refundSucceeded(payload),
      [JOB.NOTIFICATION_SEND]: (payload) => notificationSend.handle(payload),
      [JOB.REMINDER_SCHEDULE]: (payload) => reminders.schedule(payload),
      [JOB.REMINDER_SEND]: (payload) => reminders.send(payload),
      [JOB.STRIPE_EVENT]: (payload) => stripe.handle(payload),
      [JOB.MESSAGING_EVENT]: (payload) => messagingEvents.handle(payload),

      // The sweeps. Each returns a count that is logged rather than returned to BullMQ: a
      // sweep that found nothing is a success, and a job result nobody reads is noise.
      [JOB.SWEEP_EXPIRED_RESERVATIONS]: async () => {
        this.logSweep('expired reservations', await sweeper.sweepOverdue());
      },
      [JOB.SWEEP_STUCK_EXPIRING]: async () => {
        this.logSweep('stuck EXPIRING bookings', await sweeper.sweepStuckExpiring());
      },
      [JOB.SWEEP_OUTBOX]: async () => {
        const result = await outbox.reconcile();
        this.logSweep('outbox rows deleted', result.deleted);
      },
      [JOB.SWEEP_INBOX]: async () => {
        const result = await inbox.runOnce();
        this.logSweep('inbox events re-driven', result.reenqueued);
      },
      [JOB.SWEEP_NOTIFICATIONS]: async () => {
        this.logSweep('stalled notifications', await notifications.runOnce());
      },
      [JOB.SWEEP_IDEMPOTENCY_KEYS]: async () => {
        this.logSweep('idempotency keys purged', await idempotency.sweep());
      },
      [JOB.SWEEP_REMINDERS]: async () => {
        this.logSweep('reminders rebuilt', await reminderReconciler.runOnce());
      },
      [JOB.SWEEP_RETENTION]: async () => {
        const [notificationsRedacted, auditRowsDeleted] = await Promise.all([
          notifications.redactOld(),
          auditRetention.sweep(),
        ]);
        this.logSweep('notifications redacted', notificationsRedacted);
        this.logSweep('audit rows deleted', auditRowsDeleted);
      },
    };
  }

  /** Every job name this process can run. Exhaustive by construction. */
  handledJobNames(): JobName[] {
    return Object.keys(this.routes) as JobName[];
  }

  /** Start one worker per queue. Called by the worker entrypoint, never by the API. */
  start(): void {
    for (const queueName of QUEUES) {
      // A connection per worker, because the fetch is a blocking command.
      const connection = createRedisConnection(this.config.REDIS_URL);
      this.connections.push(connection);

      const worker = new Worker(
        queueName,
        async (job) => {
          await this.run(job);
        },
        {
          connection,
          prefix: this.config.REDIS_QUEUE_PREFIX,
          concurrency: this.config.WORKER_CONCURRENCY,
        },
      );

      worker.on('failed', (job, error) => {
        this.logger.error(
          `job ${job?.name ?? '(unknown)'} ${job?.id ?? ''} failed: ${error.message}`,
          error.stack,
        );
      });

      // An error on the worker itself — a lost connection, a Lua failure — is not a job
      // failure and would otherwise be an unhandled 'error' event, which ends the process.
      worker.on('error', (error) => {
        this.logger.error(`worker ${queueName} error: ${error.message}`, error.stack);
      });

      this.workers.set(queueName, worker);
    }

    this.logger.log(
      `workers running for ${QUEUES.join(', ')} at concurrency ${String(this.config.WORKER_CONCURRENCY)}`,
    );
  }

  /**
   * Run one job: validate, open a correlation scope, dispatch.
   *
   * The payload is validated here even though the enqueue side validated it too. The two
   * checks catch different things: the enqueue guards the code that produces jobs, this one
   * guards against a payload written by an older version of that code and still sitting in
   * Redis after a deploy.
   */
  private async run(job: Job): Promise<void> {
    if (!isJobName(job.name)) {
      // Not thrown: a retry cannot fix an unknown name, and failing it forever would keep
      // the job in the failed set where it looks like a bug in a handler.
      this.logger.error(`unknown job name "${job.name}"; discarding`);
      return;
    }

    const payload = parseJobPayload(job.name, job.data);

    await this.runWithJobScope(payload, async () => {
      this.logger.debug(`running ${job.name} (${job.id ?? '-'})`);
      await this.dispatch(job.name as JobName, payload);
    });
  }

  /**
   * Open the correlation scope a job runs in, on current settings.
   *
   * The id comes from the job when the enqueueing request carried one, so a log line from a
   * worker three hops later still ties back to the customer's click. A job with no id gets a
   * fresh one rather than none, so every line is attributable to *something*.
   *
   * The refresh is the other half. The organization and its settings are cached at
   * bootstrap, and the API refreshes its own copy when the office saves — but the worker
   * is a different process and nothing told it. A studio that switched SMS reminders off
   * kept being billed for them until somebody restarted it. One read per job is cheap
   * beside the work a job does, and it needs no second channel: no refresh queue, no
   * Redis subscriber, nothing else to go wrong quietly.
   */
  async runWithJobScope<T>(
    payload: { correlationId?: string | undefined },
    fn: () => Promise<T>,
  ): Promise<T> {
    return await runWithCorrelation(payload.correlationId ?? newCorrelationId(), async () => {
      try {
        await this.organizations.refresh();
      } catch (error) {
        const detail = error instanceof Error ? error.stack : String(error);
        this.logger.error('organization refresh failed; using last known settings', detail);
      }
      return await fn();
    });
  }

  /** Route a validated payload to its handler. */
  private async dispatch(name: JobName, payload: unknown): Promise<void> {
    // One cast, here, rather than one per route: the table is keyed by job name and each
    // handler takes that name's payload, a relationship no single-value cast can express.
    const handler = this.routes[name] as (input: unknown) => Promise<void>;
    await handler(payload);
  }

  /** Close every worker, waiting for in-flight jobs. Bounded, so shutdown cannot hang. */
  async stop(): Promise<void> {
    if (this.workers.size === 0) return;

    this.logger.log(`draining ${String(this.workers.size)} workers`);

    const drain = Promise.all([...this.workers.values()].map((worker) => worker.close()));

    await Promise.race([
      drain,
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.logger.warn(`workers did not drain within ${String(WORKER_DRAIN_TIMEOUT_MS)}ms`);
          resolve();
        }, WORKER_DRAIN_TIMEOUT_MS);
        // Unreferenced, so a clean drain does not keep the event loop alive for 30 seconds.
        timer.unref();
      }),
    ]);

    await Promise.all(this.connections.map((connection) => connection.quit()));

    this.workers.clear();
    this.connections.length = 0;
  }

  /** The queue a job name runs on, for the start-up log line. */
  queueOf(name: JobName): QueueName {
    return queueForJob(name);
  }

  private logSweep(what: string, count: number): void {
    if (count > 0) this.logger.log(`${what}: ${String(count)} (${correlationId()})`);
  }
}
