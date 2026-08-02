import { Inject, Injectable, Logger } from '@nestjs/common';

import { correlationId } from '../../common/correlation/correlation.store.js';

import { QUEUES, assertValidJobId, parseJobPayload, queueForJob } from './job-contracts.js';

import type { JobName, JobPayload, QueueName } from './job-contracts.js';
import type { JobsOptions, Queue } from 'bullmq';

export const QUEUE_REGISTRY = 'QUEUE_REGISTRY';

/**
 * Any declared payload.
 *
 * Queues are typed with this rather than left at BullMQ's default, which is `any`:
 * an untyped `job.data` would silently defeat every type-aware check inside a
 * processor, which is exactly where a wrong field name costs the most.
 */
export type AnyJobPayload = JobPayload<JobName>;

export type QueueRegistry = Record<QueueName, Queue<AnyJobPayload>>;

/**
 * The only way a job gets enqueued.
 *
 * Deliberately narrow. Request handlers must never call this: they write an
 * OutboxEvent in the same transaction as the state change, and the outbox
 * dispatcher enqueues from there. The gap between "committed" and "enqueued" is
 * where confirmation emails go missing, and routing every enqueue through one
 * place is what makes that rule reviewable.
 *
 * Legitimate callers: the outbox dispatcher, the webhook controllers (which have
 * already durably recorded the event in the inbox), the reconcilers, and the
 * scheduler.
 */
@Injectable()
export class EnqueueService {
  private readonly logger = new Logger('Enqueue');

  constructor(@Inject(QUEUE_REGISTRY) private readonly queues: QueueRegistry) {}

  /**
   * Validate and enqueue.
   *
   * The payload is validated here rather than only in the processor so a malformed
   * job fails at the boundary that produced it, naming the job — instead of
   * failing later with a stack trace that points at generic queue plumbing.
   */
  async enqueue<Name extends JobName>(
    name: Name,
    payload: JobPayload<Name>,
    options: JobsOptions = {},
  ): Promise<void> {
    const validated = parseJobPayload(name, payload);
    if (options.jobId !== undefined) assertValidJobId(options.jobId);
    const queue = this.queues[queueForJob(name)];

    await queue.add(
      name,
      // The correlation id is added here rather than by every caller, so a worker
      // log line ties back to the request that caused the work.
      { ...validated, correlationId: validated.correlationId ?? correlationId() },
      options,
    );

    this.logger.debug(`queued ${name}${options.jobId === undefined ? '' : ` (${options.jobId})`}`);
  }

  /** The queue behind a name, for the worker registrar and health checks. */
  queue(name: QueueName): Queue<AnyJobPayload> {
    return this.queues[name];
  }

  /** Every queue, in declaration order. */
  all(): Queue<AnyJobPayload>[] {
    return QUEUES.map((name) => this.queues[name]);
  }
}
