import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { FixedClock } from '../../src/domain/time/clock.js';
import { hashManagementToken } from '../../src/manage/management-token.service.js';
import { QUEUE } from '../../src/messaging/queues/job-contracts.js';
import { dedupeKey } from '../../src/notification/dedupe-key.js';
import { NotificationModule } from '../../src/notification/notification.module.js';
import { NotificationService } from '../../src/notification/notification.service.js';
import { ReminderReconciler } from '../../src/notification/reminder.reconciler.js';
import { ReminderService, reminderJobId } from '../../src/notification/reminder.service.js';
import { createBookingTestApp } from '../booking-app.harness.js';
import { prisma, resetDatabase } from '../database.harness.js';
import { SLOT_FRIDAY_0900, makeBooking, seedOrganization } from '../factories/index.js';
import { loadOrganization } from '../public-app.harness.js';
import { disconnectRedis, queues, resetQueues } from '../redis.harness.js';

import type { BookingStatus } from '../../src/prisma/client.js';
import type { BookingTestApp } from '../booking-app.harness.js';
import type { SeedContext } from '../factories/index.js';

/**
 * Real "now", like the notification suite.
 *
 * A delay is the difference between an application-computed instant and Redis's own idea of
 * the time. Pinning the clock days away from real time would make every delay absurd and
 * every assertion about one meaningless.
 */
const NOW = new Date();

function hoursFromNow(hours: number): Date {
  return new Date(NOW.getTime() + hours * 3_600_000);
}

function daysFromNow(days: number): Date {
  return hoursFromNow(days * 24);
}

let ctx: SeedContext;
let clock: FixedClock;
let testApp: BookingTestApp;
let service: ReminderService;
let reconciler: ReminderReconciler;
let notifications: NotificationService;

/** A booking in an arbitrary status, at an arbitrary time. */
async function bookingWithStatus(
  status: BookingStatus,
  options: { startsAt: Date },
): Promise<{ id: string; startsAt: Date }> {
  const startsAt = options.startsAt;
  const booking = await prisma.booking.create({
    data: {
      // `makeBooking` derives the appointment end, the block range and the expiry from
      // the status and the start, which is what keeps the CHECK constraints satisfied.
      ...makeBooking(ctx, { status, startsAt }),
      ...(status === 'CONFIRMED' ? { confirmedAt: NOW } : {}),
      ...(status.startsWith('CANCELED') ? { canceledAt: NOW } : {}),
    },
  });

  return { id: booking.id, startsAt: booking.startsAt };
}

async function confirmedBooking(options: { startsAt: Date }): Promise<{
  id: string;
  startsAt: Date;
}> {
  return await bookingWithStatus('CONFIRMED', options);
}

/** Move an appointment, block range included, so the CHECK constraints stay satisfied. */
function movedTo(startsAt: Date) {
  const endsAt = new Date(startsAt.getTime() + 30 * 60_000);

  return {
    startsAt,
    endsAt,
    blockStartsAt: startsAt,
    blockEndsAt: new Date(endsAt.getTime() + 5 * 60_000),
  };
}

function fireArgs(booking: { id: string; startsAt: Date }, offsetMinutes = 1440) {
  return {
    bookingId: booking.id,
    offsetMinutes,
    expectedStartsAtEpochSeconds: Math.floor(booking.startsAt.getTime() / 1000),
  };
}

/** Rebuild the app so a settings change is seen — settings are cached at bootstrap. */
async function setSettings(data: Record<string, unknown>): Promise<void> {
  await prisma.organizationSettings.updateMany({ data });
  await testApp.close();
  await build();
}

async function build(): Promise<void> {
  testApp = await createBookingTestApp({
    organization: await loadOrganization(ctx.organization.id),
    clock,
    queues,
    extraImports: [NotificationModule],
  });

  service = testApp.app.get(ReminderService);
  reconciler = testApp.app.get(ReminderReconciler);
  notifications = testApp.app.get(NotificationService);
}

/**
 * The offset a delayed job carries.
 *
 * The registry is typed with the union of every job payload, so the reminder-specific field
 * needs narrowing at the read rather than a queue typed loosely enough to skip it.
 */
function offsetOf(job: { data: unknown } | undefined): number | undefined {
  return (job?.data as { offsetMinutes?: number } | undefined)?.offsetMinutes;
}

function delayed() {
  return queues[QUEUE.NOTIFICATION].getDelayed();
}

beforeEach(async () => {
  await resetDatabase();
  await resetQueues();
  ctx = await seedOrganization(prisma);
  clock = new FixedClock(NOW);
  await build();

  return async () => {
    await testApp.close();
  };
});

afterAll(async () => {
  await disconnectRedis();
});

describe('scheduling', () => {
  it('embeds the appointment time in the job id', async () => {
    const booking = await confirmedBooking({ startsAt: daysFromNow(3) });

    expect(await service.schedule(booking.id)).toEqual({ scheduled: 1, skipped: 0 });

    const jobs = await delayed();
    expect(jobs[0]?.id).toBe(
      `reminder-1440-${booking.id}-${String(Math.floor(booking.startsAt.getTime() / 1000))}`,
    );
  });

  it('uses a job id BullMQ accepts, which the plan’s colons would not be', async () => {
    const booking = await confirmedBooking({ startsAt: daysFromNow(3) });
    await service.schedule(booking.id);

    // BullMQ reserves `:` as its key separator and rejects a custom id containing one, so
    // the plan's `reminder:1440:<id>:<epoch>` cannot be used verbatim.
    const jobs = await delayed();
    expect(jobs[0]?.id).not.toContain(':');
    expect(jobs).toHaveLength(1);
  });

  it('sets a delay that lands one offset before the appointment', async () => {
    const startsAt = daysFromNow(3);
    const booking = await confirmedBooking({ startsAt });
    await service.schedule(booking.id);

    const jobs = await delayed();
    const expected = startsAt.getTime() - 1440 * 60_000 - NOW.getTime();

    // Within a second: the harness clock is fixed at NOW while Redis stamps its own.
    expect(jobs[0]?.opts.delay ?? 0).toBeGreaterThan(expected - 2000);
    expect(jobs[0]?.opts.delay ?? 0).toBeLessThanOrEqual(expected);
  });

  it('schedules a distinct job after a reschedule, which a booking-id-only key would have swallowed', async () => {
    const booking = await confirmedBooking({ startsAt: daysFromNow(3) });
    await service.schedule(booking.id);

    const moved = await prisma.booking.update({
      where: { id: booking.id },
      data: movedTo(daysFromNow(4)),
    });
    await service.schedule(moved.id);

    const ids = (await delayed()).map((job) => job.id);
    // BullMQ silently ignores an `add` under an existing id, so an id keyed on the booking
    // alone would leave the customer with a reminder for the time they moved away from.
    expect(new Set(ids).size).toBe(2);
  });

  it('skips a past-due offset instead of firing immediately', async () => {
    const booking = await confirmedBooking({ startsAt: hoursFromNow(6) });

    // Booking for tomorrow morning has not earned a "in 24 hours" message that arrives
    // while the customer is still on the confirmation page.
    expect(await service.schedule(booking.id)).toEqual({ scheduled: 0, skipped: 1 });
    expect(await delayed()).toHaveLength(0);
  });

  it('honours multiple configured offsets', async () => {
    await setSettings({ reminderOffsetsMinutes: [1440, 120] });
    const booking = await confirmedBooking({ startsAt: daysFromNow(3) });

    expect(await service.schedule(booking.id)).toEqual({ scheduled: 2, skipped: 0 });
    expect(await delayed()).toHaveLength(2);
  });

  it('schedules the far offset first, so the queue order reads chronologically', async () => {
    await setSettings({ reminderOffsetsMinutes: [120, 1440] });
    const booking = await confirmedBooking({ startsAt: daysFromNow(3) });
    await service.schedule(booking.id);

    const jobs = await delayed();
    expect(jobs.map(offsetOf)).toEqual([1440, 120]);
  });

  it('schedules nothing for a booking that is not confirmed', async () => {
    const booking = await bookingWithStatus('PENDING_PAYMENT', { startsAt: daysFromNow(3) });

    expect(await service.schedule(booking.id)).toEqual({ scheduled: 0, skipped: 0 });
    expect(await delayed()).toHaveLength(0);
  });

  it('schedules nothing for a booking that no longer exists', async () => {
    expect(await service.schedule('cms9gryv30000ja32145w5gke')).toEqual({
      scheduled: 0,
      skipped: 0,
    });
  });
});

describe('firing', () => {
  it('sends when the booking still matches', async () => {
    const booking = await confirmedBooking({ startsAt: daysFromNow(3) });

    expect(await service.fire(fireArgs(booking))).toBe('SENT');
    expect(
      await prisma.notification.count({ where: { bookingId: booking.id, kind: 'REMINDER_24H' } }),
    ).toBe(1);
  });

  it('mints a fresh management token, because the confirmation plaintext is long gone', async () => {
    const booking = await confirmedBooking({ startsAt: daysFromNow(3) });
    await service.fire(fireArgs(booking));

    const row = await prisma.notification.findFirstOrThrow({ where: { bookingId: booking.id } });
    await notifications.send(row.id);

    const link = /\/manage#([\w-]+)/.exec(testApp.email.sent[0]?.text ?? '');
    expect(link).not.toBeNull();

    // The plaintext is in the email and only the hash is stored, so the link works and the
    // database never holds a usable credential.
    const token = await prisma.managementToken.findUniqueOrThrow({
      where: { tokenHash: hashManagementToken(link?.[1] ?? '') },
    });
    expect(token.bookingId).toBe(booking.id);
    expect(token.revokedAt).toBeNull();
  });

  it.each([
    'CANCELED_BY_CUSTOMER',
    'CANCELED_BY_BUSINESS',
    'NO_SHOW',
    'COMPLETED',
    'EXPIRED',
  ] as const)('skips a %s booking at fire time', async (status) => {
    const booking = await bookingWithStatus(status, { startsAt: daysFromNow(3) });

    expect(await service.fire(fireArgs(booking))).toBe('SKIPPED');
    expect(await prisma.notification.count({ where: { bookingId: booking.id } })).toBe(0);
  });

  it('skips when the appointment time no longer matches the job', async () => {
    const booking = await confirmedBooking({ startsAt: daysFromNow(3) });
    const args = fireArgs(booking);

    await prisma.booking.update({ where: { id: booking.id }, data: movedTo(daysFromNow(4)) });

    // The rescheduled booking has its own job under a different id. Without this check the
    // customer would be reminded of a time they no longer hold.
    expect(await service.fire(args)).toBe('SKIPPED');
    expect(await prisma.notification.count({ where: { bookingId: booking.id } })).toBe(0);
  });

  it('skips a booking that has been deleted', async () => {
    const booking = await confirmedBooking({ startsAt: daysFromNow(3) });
    const args = fireArgs(booking);
    await prisma.booking.delete({ where: { id: booking.id } });

    expect(await service.fire(args)).toBe('SKIPPED');
  });

  it('is idempotent when the same reminder job runs twice', async () => {
    const booking = await confirmedBooking({ startsAt: daysFromNow(3) });

    await service.fire(fireArgs(booking));
    await service.fire(fireArgs(booking));

    expect(
      await prisma.notification.count({ where: { bookingId: booking.id, kind: 'REMINDER_24H' } }),
    ).toBe(1);
  });

  it('keeps two offsets for the same appointment distinct', async () => {
    await setSettings({ reminderOffsetsMinutes: [1440, 120] });
    const booking = await confirmedBooking({ startsAt: daysFromNow(3) });

    await service.fire(fireArgs(booking, 1440));
    await service.fire(fireArgs(booking, 120));

    // The discriminator carries the offset as well as the time. Keying on the time alone
    // would dedupe the 2-hour reminder into the 24-hour one already sent.
    expect(
      await prisma.notification.count({ where: { bookingId: booking.id, kind: 'REMINDER_24H' } }),
    ).toBe(2);
  });

  it('does not accumulate management tokens when the same reminder is fired again', async () => {
    const booking = await confirmedBooking({ startsAt: daysFromNow(3) });

    await service.fire(fireArgs(booking));
    await service.fire(fireArgs(booking));

    expect(await prisma.managementToken.count({ where: { bookingId: booking.id } })).toBe(1);
  });

  it('adds an SMS only when enabled and a number exists', async () => {
    await setSettings({ smsRemindersEnabled: true });
    const booking = await confirmedBooking({ startsAt: daysFromNow(3) });

    await service.fire(fireArgs(booking));
    expect(
      await prisma.notification.count({ where: { bookingId: booking.id, channel: 'SMS' } }),
    ).toBe(1);

    await prisma.notification.deleteMany({ where: { bookingId: booking.id } });
    await prisma.customer.updateMany({ data: { phone: null } });

    await service.fire(fireArgs(booking));
    expect(
      await prisma.notification.count({ where: { bookingId: booking.id, channel: 'SMS' } }),
    ).toBe(0);
  });
});

describe('cancelling', () => {
  it('removes the delayed jobs', async () => {
    const booking = await confirmedBooking({ startsAt: daysFromNow(3) });
    await service.schedule(booking.id);
    expect(await delayed()).toHaveLength(1);

    await service.cancelFor(booking.id);
    expect(await delayed()).toHaveLength(0);
  });

  it('tolerates a failed removal, because fire re-validates anyway', async () => {
    const booking = await confirmedBooking({ startsAt: daysFromNow(3) });
    await service.schedule(booking.id);
    await queues[QUEUE.NOTIFICATION].obliterate({ force: true });

    await expect(service.cancelFor(booking.id)).resolves.toBeUndefined();
  });

  it('does nothing for a booking that no longer exists', async () => {
    await expect(service.cancelFor('cms9gryv30000ja32145w5gke')).resolves.toBeUndefined();
  });
});

describe('the reconciler', () => {
  it('survives a lost queue: it rebuilds the next 48 hours', async () => {
    const booking = await confirmedBooking({ startsAt: hoursFromNow(30) });
    await service.schedule(booking.id);
    await queues[QUEUE.NOTIFICATION].obliterate({ force: true });

    // The delayed set is the only state that is not in PostgreSQL, and a flush takes it
    // with no trace. Everything needed to rebuild it is in the database.
    expect(await reconciler.runOnce()).toBe(1);
    expect(await delayed()).toHaveLength(1);
  });

  it('rebuilds with the same job id, so a later sweep is a no-op', async () => {
    const booking = await confirmedBooking({ startsAt: hoursFromNow(30) });
    await service.schedule(booking.id);
    const before = (await delayed()).map((job) => job.id);

    await queues[QUEUE.NOTIFICATION].obliterate({ force: true });
    await reconciler.runOnce();

    expect((await delayed()).map((job) => job.id)).toEqual(before);
    expect(await reconciler.runOnce()).toBe(0);
  });

  it('does not rebuild a reminder that already sent', async () => {
    const booking = await confirmedBooking({ startsAt: hoursFromNow(30) });
    const row = await prisma.notification.findFirst({ where: { bookingId: booking.id } });
    expect(row).toBeNull();

    await service.fire(fireArgs(booking));
    const sent = await prisma.notification.findFirstOrThrow({
      where: { bookingId: booking.id },
    });
    await notifications.send(sent.id);
    await queues[QUEUE.NOTIFICATION].obliterate({ force: true });

    // A sent reminder has no job left either, so "the job is missing" alone would send
    // every reminder again every night.
    expect(await reconciler.runOnce()).toBe(0);
  });

  it('leaves a pending reminder to the notification reconciler', async () => {
    const booking = await confirmedBooking({ startsAt: hoursFromNow(30) });
    await service.fire(fireArgs(booking));
    await queues[QUEUE.NOTIFICATION].obliterate({ force: true });

    expect(await reconciler.runOnce()).toBe(0);
  });

  it('continues past a full page of already handled bookings', async () => {
    const startsAt = hoursFromNow(30);
    const employees = await prisma.employee.createManyAndReturn({
      data: Array.from({ length: 501 }, (_, index) => ({
        organizationId: ctx.organization.id,
        firstName: 'Page',
        lastName: String(index),
        displayName: `Page ${String(index)}`,
        displayOrder: index,
      })),
      select: { id: true },
    });
    const bookings = await prisma.booking.createManyAndReturn({
      data: employees.map((employee, index) => ({
        ...makeBooking(ctx, { status: 'CONFIRMED', startsAt }),
        employeeId: employee.id,
        reference: `PAGE-${String(index).padStart(3, '0')}`,
        confirmedAt: NOW,
      })),
      select: { id: true, startsAt: true },
    });

    await prisma.notification.createMany({
      data: bookings.slice(0, 500).map((booking) => ({
        organizationId: ctx.organization.id,
        bookingId: booking.id,
        kind: 'REMINDER_24H' as const,
        channel: 'EMAIL' as const,
        locale: 'de' as const,
        recipient: 'page@example.com',
        status: 'SENT' as const,
        dedupeKey: dedupeKey(
          'REMINDER_24H',
          'EMAIL',
          booking.id,
          service.reminderDedupeDiscriminator(1440, booking.startsAt),
        ),
      })),
    });

    expect(await reconciler.runOnce()).toBe(1);
  });

  it('leaves a job that is still there alone', async () => {
    const booking = await confirmedBooking({ startsAt: hoursFromNow(30) });
    await service.schedule(booking.id);

    expect(await reconciler.runOnce()).toBe(0);
    expect(await delayed()).toHaveLength(1);
  });

  it('ignores appointments beyond the horizon', async () => {
    const booking = await confirmedBooking({ startsAt: daysFromNow(10) });
    await service.schedule(booking.id);
    await queues[QUEUE.NOTIFICATION].obliterate({ force: true });

    // The sweep runs nightly, so anything reaching its reminder before the next run is
    // inside 48 hours. Rebuilding months of jobs every night would prove the same thing
    // thousands of times.
    expect(await reconciler.runOnce()).toBe(0);
  });

  it('ignores appointments that are not confirmed', async () => {
    await bookingWithStatus('CANCELED_BY_CUSTOMER', { startsAt: hoursFromNow(30) });

    expect(await reconciler.runOnce()).toBe(0);
  });

  it('skips an offset that is already past due', async () => {
    await setSettings({ reminderOffsetsMinutes: [1440, 120] });
    const booking = await confirmedBooking({ startsAt: hoursFromNow(6) });
    await service.schedule(booking.id);
    await queues[QUEUE.NOTIFICATION].obliterate({ force: true });

    // 24 hours before is in the past; 2 hours before is not.
    expect(await reconciler.runOnce()).toBe(1);
    expect(offsetOf((await delayed())[0])).toBe(120);
    expect(booking.startsAt.getTime()).toBeGreaterThan(NOW.getTime());
  });

  // Offsets are a per-tenant setting. Read once outside any tenant scope, the sweep
  // applies the bootstrap organization's list to everybody: one business loses the
  // reminders it configured, another gets reminders it never asked for.
  it('rebuilds each organization with its own offsets', async () => {
    const other = await seedOrganization(prisma, { slug: 'other-tenant' });

    await prisma.organizationSettings.update({
      where: { organizationId: ctx.organization.id },
      data: { reminderOffsetsMinutes: [1440] },
    });
    await prisma.organizationSettings.update({
      where: { organizationId: other.organization.id },
      data: { reminderOffsetsMinutes: [1440, 120] },
    });
    await testApp.close();
    await build();

    const startsAt = hoursFromNow(30);
    await confirmedBooking({ startsAt });
    await prisma.booking.create({
      data: { ...makeBooking(other, { status: 'CONFIRMED', startsAt }), confirmedAt: NOW },
    });

    expect(await reconciler.runOnce()).toBe(3);

    const byOrganization = new Map<string, number[]>();
    for (const job of await delayed()) {
      const { organizationId } = job.data as { organizationId: string };
      byOrganization.set(organizationId, [
        ...(byOrganization.get(organizationId) ?? []),
        offsetOf(job) ?? -1,
      ]);
    }

    expect(byOrganization.get(ctx.organization.id)?.sort()).toEqual([1440]);
    expect(byOrganization.get(other.organization.id)?.sort()).toEqual([120, 1440]);
  });
});

describe('the job id', () => {
  it('is stable for the same booking and time', () => {
    const startsAt = SLOT_FRIDAY_0900;

    expect(reminderJobId(1440, 'bk_1', startsAt)).toBe(reminderJobId(1440, 'bk_1', startsAt));
    expect(reminderJobId(1440, 'bk_1', startsAt)).not.toBe(reminderJobId(120, 'bk_1', startsAt));
  });

  it('ignores sub-second differences, which a Date carries and a schedule does not', () => {
    const exact = new Date('2026-08-14T07:00:00.000Z');
    const jittered = new Date('2026-08-14T07:00:00.400Z');

    // The payload and the id both floor to epoch seconds, so a booking whose stored time
    // has milliseconds still matches its own job.
    expect(reminderJobId(1440, 'bk_1', exact)).toBe(reminderJobId(1440, 'bk_1', jittered));
  });
});
