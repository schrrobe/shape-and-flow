import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { FixedClock } from '../../src/domain/time/clock.js';
import {
  INBOX_MAX_ATTEMPTS,
  INBOX_MESSAGING_RETENTION_DAYS,
  INBOX_STALLED_AFTER_MS,
  INBOX_STRIPE_RETENTION_DAYS,
  InboxReconciler,
  inboxJobId,
} from '../../src/messaging/inbox/inbox.reconciler.js';
import { InboxRecorder } from '../../src/messaging/inbox/inbox.recorder.js';
import { EnqueueService as RealEnqueueService } from '../../src/messaging/queues/enqueue.service.js';
import { JOB, QUEUE } from '../../src/messaging/queues/job-contracts.js';
import { prisma, resetDatabase } from '../database.harness.js';
import { disconnectRedis, queues, resetQueues } from '../redis.harness.js';

import type { EnqueueService } from '../../src/messaging/queues/enqueue.service.js';
import type { PrismaService } from '../../src/prisma/prisma.service.js';

/** The harness client is a plain PrismaClient; the services declare PrismaService. */
const db = prisma as unknown as PrismaService;

let clock: FixedClock;
let recorder: InboxRecorder;
let enqueue: { enqueue: ReturnType<typeof vi.fn> };
let reconciler: InboxReconciler;

/** Backdate an event so it falls inside the reconciler's stalled window. */
async function backdateStripe(stripeEventId: string, ms: number): Promise<void> {
  await prisma.stripeWebhookEvent.updateMany({
    where: { stripeEventId },
    data: { receivedAt: new Date(clock.now().getTime() - ms) },
  });
}

beforeEach(async () => {
  await resetDatabase();

  // Anchored to the real clock, because Prisma writes `receivedAt` from this same
  // process via `@default(now())` — a clock pinned to an arbitrary instant would
  // disagree with the rows these tests insert. See the note in the outbox spec.
  clock = new FixedClock(new Date());

  recorder = new InboxRecorder(db, clock);
  enqueue = { enqueue: vi.fn().mockResolvedValue(undefined) };
  reconciler = new InboxReconciler(db, enqueue as unknown as EnqueueService, clock);
});

describe('recording a stripe event', () => {
  it('records a new event and reports RECORDED with its row id', async () => {
    const result = await recorder.recordStripe({
      id: 'evt_1',
      type: 'checkout.session.completed',
      apiVersion: '2026-07-29.dahlia',
      payload: { object: 'event' },
    });

    expect(result.outcome).toBe('RECORDED');
    expect(result.rowId).toEqual(expect.any(String));

    const row = await prisma.stripeWebhookEvent.findUniqueOrThrow({
      where: { stripeEventId: 'evt_1' },
    });
    expect(row.type).toBe('checkout.session.completed');
    expect(row.apiVersion).toBe('2026-07-29.dahlia');
    expect(row.payload).toEqual({ object: 'event' });
    expect(row.processedAt).toBeNull();
    expect(row.attempts).toBe(0);
    // No organization yet: the tenant is resolved from whatever the event refers to.
    expect(row.organizationId).toBeNull();
  });

  it('reports DUPLICATE for the same event id without writing a second row', async () => {
    await recorder.recordStripe({ id: 'evt_1', type: 'checkout.session.completed', payload: {} });
    const again = await recorder.recordStripe({
      id: 'evt_1',
      type: 'checkout.session.completed',
      payload: {},
    });

    expect(again.outcome).toBe('DUPLICATE');
    expect(again.rowId).toBeNull();
    expect(await prisma.stripeWebhookEvent.count({ where: { stripeEventId: 'evt_1' } })).toBe(1);
  });

  it('reports DUPLICATE for exactly one of two simultaneous deliveries', async () => {
    // The reason for insert-then-catch rather than check-then-insert: both of these
    // would pass a check before either had written anything.
    const results = await Promise.all([
      recorder.recordStripe({ id: 'evt_race', type: 'x', payload: {} }),
      recorder.recordStripe({ id: 'evt_race', type: 'x', payload: {} }),
    ]);

    expect(results.map((r) => r.outcome).sort()).toEqual(['DUPLICATE', 'RECORDED']);
    expect(await prisma.stripeWebhookEvent.count()).toBe(1);
  });

  it('keeps the first payload, not the redelivery, so the record is what arrived first', async () => {
    await recorder.recordStripe({ id: 'evt_1', type: 'x', payload: { attempt: 'first' } });
    await recorder.recordStripe({ id: 'evt_1', type: 'x', payload: { attempt: 'second' } });

    const row = await prisma.stripeWebhookEvent.findUniqueOrThrow({
      where: { stripeEventId: 'evt_1' },
    });
    expect(row.payload).toEqual({ attempt: 'first' });
  });

  it('omits apiVersion when the event has none', async () => {
    await recorder.recordStripe({ id: 'evt_1', type: 'x', payload: {} });

    const row = await prisma.stripeWebhookEvent.findUniqueOrThrow({
      where: { stripeEventId: 'evt_1' },
    });
    expect(row.apiVersion).toBeNull();
  });
});

describe('recording a messaging event', () => {
  it('lets the same provider event id exist once per provider', async () => {
    // The unique key is composite. Two providers numbering their events
    // independently must not collide.
    const resend = await recorder.recordMessaging('RESEND', {
      id: 'shared-1',
      type: 'email.delivered',
      payload: {},
    });
    const twilio = await recorder.recordMessaging('TWILIO', {
      id: 'shared-1',
      type: 'delivered',
      payload: {},
    });

    expect(resend.outcome).toBe('RECORDED');
    expect(twilio.outcome).toBe('RECORDED');
    expect(await prisma.messagingWebhookEvent.count()).toBe(2);
  });

  it('reports DUPLICATE for the same id from the same provider', async () => {
    await recorder.recordMessaging('RESEND', { id: 'e1', type: 'email.sent', payload: {} });
    const again = await recorder.recordMessaging('RESEND', {
      id: 'e1',
      type: 'email.sent',
      payload: {},
    });

    expect(again.outcome).toBe('DUPLICATE');
    expect(await prisma.messagingWebhookEvent.count()).toBe(1);
  });
});

describe('marking events', () => {
  it('marks processed idempotently, keeping the first timestamp', async () => {
    await recorder.recordStripe({ id: 'evt_1', type: 'x', payload: {} });

    await recorder.markProcessed({ kind: 'stripe', stripeEventId: 'evt_1' });
    const first = await prisma.stripeWebhookEvent.findUniqueOrThrow({
      where: { stripeEventId: 'evt_1' },
    });

    // A redelivery must not rewrite when the event was actually acted on.
    clock.advanceMinutes(5);
    await recorder.markProcessed({ kind: 'stripe', stripeEventId: 'evt_1' });
    const second = await prisma.stripeWebhookEvent.findUniqueOrThrow({
      where: { stripeEventId: 'evt_1' },
    });

    expect(second.processedAt).toEqual(first.processedAt);
  });

  it('records attempts and the last error on failure, leaving it unprocessed', async () => {
    await recorder.recordStripe({ id: 'evt_1', type: 'x', payload: {} });
    await recorder.markFailed({ kind: 'stripe', stripeEventId: 'evt_1' }, new Error('boom'));

    const row = await prisma.stripeWebhookEvent.findUniqueOrThrow({
      where: { stripeEventId: 'evt_1' },
    });
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain('boom');
    expect(row.processedAt).toBeNull();
  });

  it('counts each failure', async () => {
    await recorder.recordStripe({ id: 'evt_1', type: 'x', payload: {} });

    await recorder.markFailed({ kind: 'stripe', stripeEventId: 'evt_1' }, new Error('one'));
    await recorder.markFailed({ kind: 'stripe', stripeEventId: 'evt_1' }, new Error('two'));

    const row = await prisma.stripeWebhookEvent.findUniqueOrThrow({
      where: { stripeEventId: 'evt_1' },
    });
    expect(row.attempts).toBe(2);
    expect(row.lastError).toContain('two');
  });

  it('marks and fails a messaging event by its composite key only', async () => {
    await recorder.recordMessaging('RESEND', { id: 'shared', type: 'x', payload: {} });
    await recorder.recordMessaging('TWILIO', { id: 'shared', type: 'x', payload: {} });

    await recorder.markProcessed({
      kind: 'messaging',
      provider: 'RESEND',
      providerEventId: 'shared',
    });
    await recorder.markFailed(
      { kind: 'messaging', provider: 'TWILIO', providerEventId: 'shared' },
      new Error('sms failed'),
    );

    const resend = await prisma.messagingWebhookEvent.findFirstOrThrow({
      where: { provider: 'RESEND' },
    });
    const twilio = await prisma.messagingWebhookEvent.findFirstOrThrow({
      where: { provider: 'TWILIO' },
    });

    // Neither operation touched the other provider's row.
    expect(resend.processedAt).not.toBeNull();
    expect(resend.attempts).toBe(0);
    expect(twilio.processedAt).toBeNull();
    expect(twilio.attempts).toBe(1);
  });

  it('accepts a mark for an event that does not exist, rather than throwing', async () => {
    // updateMany, not update: a processor for an event pruned in the meantime should
    // not crash the worker over it.
    await expect(
      recorder.markProcessed({ kind: 'stripe', stripeEventId: 'evt_gone' }),
    ).resolves.toBeUndefined();
  });

  it('truncates a very long provider error', async () => {
    await recorder.recordStripe({ id: 'evt_1', type: 'x', payload: {} });
    await recorder.markFailed(
      { kind: 'stripe', stripeEventId: 'evt_1' },
      new Error('x'.repeat(5000)),
    );

    const row = await prisma.stripeWebhookEvent.findUniqueOrThrow({
      where: { stripeEventId: 'evt_1' },
    });
    expect(row.lastError?.length).toBe(1000);
  });
});

describe('the reconciler', () => {
  it('re-enqueues an event left unprocessed past the window', async () => {
    const recorded = await recorder.recordStripe({ id: 'evt_old', type: 'x', payload: {} });
    await backdateStripe('evt_old', INBOX_STALLED_AFTER_MS + 60_000);

    const result = await reconciler.runOnce();

    expect(result.reenqueued).toBe(1);
    expect(enqueue.enqueue).toHaveBeenCalledWith(
      JOB.STRIPE_EVENT,
      { stripeEventId: 'evt_old' },
      // Derived from the row id, not the plan's `stripe:evt_old` — a colon is
      // invalid in a BullMQ job id, and a provider id is not guaranteed key-safe.
      { jobId: inboxJobId(recorded.rowId ?? '') },
    );
  });

  it('does not re-enqueue a fresh unprocessed event', async () => {
    await recorder.recordStripe({ id: 'evt_new', type: 'x', payload: {} });

    expect((await reconciler.runOnce()).reenqueued).toBe(0);
    expect(enqueue.enqueue).not.toHaveBeenCalled();
  });

  it('does not re-enqueue an event that has been processed', async () => {
    await recorder.recordStripe({ id: 'evt_done', type: 'x', payload: {} });
    await backdateStripe('evt_done', INBOX_STALLED_AFTER_MS + 60_000);
    await recorder.markProcessed({ kind: 'stripe', stripeEventId: 'evt_done' });

    expect((await reconciler.runOnce()).reenqueued).toBe(0);
  });

  it('reports a poisoned event rather than re-enqueueing it forever', async () => {
    await recorder.recordStripe({ id: 'evt_poison', type: 'x', payload: {} });
    await backdateStripe('evt_poison', INBOX_STALLED_AFTER_MS + 60_000);
    await prisma.stripeWebhookEvent.updateMany({
      where: { stripeEventId: 'evt_poison' },
      data: { attempts: INBOX_MAX_ATTEMPTS, lastError: 'always fails' },
    });

    const result = await reconciler.runOnce();

    expect(result.poisoned).toBe(1);
    expect(result.reenqueued).toBe(0);
    expect(enqueue.enqueue).not.toHaveBeenCalled();
  });

  it('re-enqueues messaging events too, with their provider', async () => {
    const recorded = await recorder.recordMessaging('TWILIO', {
      id: 'sms-1',
      type: 'delivered',
      payload: {},
    });
    await prisma.messagingWebhookEvent.updateMany({
      data: { receivedAt: new Date(clock.now().getTime() - INBOX_STALLED_AFTER_MS - 60_000) },
    });

    expect((await reconciler.runOnce()).reenqueued).toBe(1);
    expect(enqueue.enqueue).toHaveBeenCalledWith(
      JOB.MESSAGING_EVENT,
      { provider: 'TWILIO', providerEventId: 'sms-1' },
      { jobId: inboxJobId(recorded.rowId ?? '') },
    );
  });

  it('reports health per kind', async () => {
    await recorder.recordStripe({ id: 'evt_fresh', type: 'x', payload: {} });
    await recorder.recordStripe({ id: 'evt_stale', type: 'x', payload: {} });
    await backdateStripe('evt_stale', INBOX_STALLED_AFTER_MS + 60_000);
    await recorder.recordMessaging('RESEND', { id: 'e1', type: 'x', payload: {} });

    expect(await reconciler.health()).toEqual({
      stripe: { pending: 2, stalled: 1, poisoned: 0 },
      messaging: { pending: 1, stalled: 0, poisoned: 0 },
    });
  });

  it('prunes processed events past their own retention window', async () => {
    // Stripe rows are payment evidence and are kept three times as long, so a
    // messaging row of the same age goes while the Stripe row stays.
    const ageDays = INBOX_MESSAGING_RETENTION_DAYS + 1;
    const processedAt = new Date(clock.now().getTime() - ageDays * 86_400_000);

    await recorder.recordStripe({ id: 'evt_1', type: 'x', payload: {} });
    await recorder.recordMessaging('RESEND', { id: 'e1', type: 'x', payload: {} });
    await prisma.stripeWebhookEvent.updateMany({ data: { processedAt } });
    await prisma.messagingWebhookEvent.updateMany({ data: { processedAt } });

    expect((await reconciler.runOnce()).deleted).toBe(1);
    expect(await prisma.stripeWebhookEvent.count()).toBe(1);
    expect(await prisma.messagingWebhookEvent.count()).toBe(0);
  });

  it('prunes a stripe event once it is past ninety days', async () => {
    await recorder.recordStripe({ id: 'evt_1', type: 'x', payload: {} });
    await prisma.stripeWebhookEvent.updateMany({
      data: {
        processedAt: new Date(
          clock.now().getTime() - (INBOX_STRIPE_RETENTION_DAYS + 1) * 86_400_000,
        ),
      },
    });

    expect((await reconciler.runOnce()).deleted).toBe(1);
    expect(await prisma.stripeWebhookEvent.count()).toBe(0);
  });

  it('never prunes an unprocessed event, however old', async () => {
    await recorder.recordStripe({ id: 'evt_ancient', type: 'x', payload: {} });
    await backdateStripe('evt_ancient', (INBOX_STRIPE_RETENTION_DAYS + 10) * 86_400_000);

    const result = await reconciler.runOnce();

    expect(result.deleted).toBe(0);
    expect(result.reenqueued).toBe(1);
    expect(await prisma.stripeWebhookEvent.count()).toBe(1);
  });
});

describe('end to end, through the real queue', () => {
  beforeEach(async () => {
    await resetQueues();
  });

  afterAll(async () => {
    await disconnectRedis();
  });

  it('re-enqueues a stalled event onto the webhook queue, once', async () => {
    const real = new RealEnqueueService(queues);
    const live = new InboxReconciler(db, real, clock);

    const recorded = await recorder.recordStripe({ id: 'evt_stalled', type: 'x', payload: {} });
    await backdateStripe('evt_stalled', INBOX_STALLED_AFTER_MS + 60_000);

    expect((await live.runOnce()).reenqueued).toBe(1);

    const [job] = await queues[QUEUE.WEBHOOK].getJobs(['waiting']);
    expect(job?.name).toBe(JOB.STRIPE_EVENT);
    expect(job?.id).toBe(inboxJobId(recorded.rowId ?? ''));
    expect(job?.data).toMatchObject({ stripeEventId: 'evt_stalled' });

    // A second sweep before the worker gets to it must not queue a duplicate: the
    // job id is deterministic, so BullMQ discards it.
    expect((await live.runOnce()).reenqueued).toBe(1);
    expect(await queues[QUEUE.WEBHOOK].getJobs(['waiting'])).toHaveLength(1);
  });
});
