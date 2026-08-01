import { createHmac } from 'node:crypto';

import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { FixedClock } from '../../src/domain/time/clock.js';
import { dedupeKey } from '../../src/notification/dedupe-key.js';
import {
  NOTIFICATION_STALLED_AFTER_MS,
  NotificationReconciler,
  REDACTED,
} from '../../src/notification/notification.reconciler.js';
import { NotificationService } from '../../src/notification/notification.service.js';
import { BookingEventProcessor } from '../../src/notification/processors/booking-event.processor.js';
import { MessagingEventProcessor } from '../../src/notification/processors/messaging-event.processor.js';
import { WebhooksModule } from '../../src/webhooks/webhooks.module.js';
import { PUBLIC_WEB_ORIGIN, createBookingTestApp, enqueued } from '../booking-app.harness.js';
import { prisma, resetDatabase } from '../database.harness.js';
import { SLOT_FRIDAY_0900, makeBooking, seedOrganization } from '../factories/index.js';
import { loadOrganization } from '../public-app.harness.js';

import type { BookingTestApp } from '../booking-app.harness.js';
import type { SeedContext } from '../factories/index.js';
import type { Server } from 'node:http';

/**
 * Real "now", not a fixed instant.
 *
 * `createdAt` is written by Prisma at real time and the reconciler compares against it. A
 * clock pinned days ahead would make every fresh row look stalled — the same trap the
 * outbox, inbox and expiry suites record. Tests that need a stalled row backdate it.
 */
const NOW = new Date();
const TOKEN = 'tok_sample_management_token';

let ctx: SeedContext;
let clock: FixedClock;
let testApp: BookingTestApp;
let server: () => Server;
let service: NotificationService;
let reconciler: NotificationReconciler;
let bookingEvents: BookingEventProcessor;
let messagingEvents: MessagingEventProcessor;
let bookingId: string;

/** A confirmed, paid booking with a customer who has a phone number. */
async function confirmedBooking(): Promise<string> {
  const booking = await prisma.booking.create({
    data: {
      ...makeBooking(ctx, { status: 'CONFIRMED', expiresAt: null }),
      confirmedAt: NOW,
      customerNote: 'Erstbesuch',
    },
  });

  await prisma.payment.create({
    data: {
      organizationId: ctx.organization.id,
      bookingId: booking.id,
      stripeCheckoutSessionId: `cs_test_${booking.id}`,
      amountCents: booking.priceCentsSnapshot,
      currency: booking.currency,
      status: 'SUCCEEDED',
      paidAt: NOW,
    },
  });

  return booking.id;
}

/** Queue a confirmation the way the processor does, but directly, for the unit-ish cases. */
async function queueConfirmation(): Promise<{ notificationId: string | null }> {
  return await prisma.$transaction((tx) =>
    service.queue(tx, {
      organizationId: ctx.organization.id,
      kind: 'BOOKING_CONFIRMATION',
      channel: 'EMAIL',
      locale: 'de',
      recipient: ctx.customer.email,
      bookingId,
      customerId: ctx.customer.id,
      data: {
        businessName: 'Shape and Flow',
        businessPhone: '+49301234567',
        addressLine: 'Beispielstraße 1, 10115 Berlin',
        businessEmail: 'hallo@shape-and-flow.example',
        reference: 'SF-TEST01',
        serviceName: ctx.service30.name,
        employeeName: 'Mara Vogt',
        startsAt: SLOT_FRIDAY_0900,
        endsAt: new Date(SLOT_FRIDAY_0900.getTime() + 30 * 60_000),
        priceCents: ctx.service30.priceCents,
        currency: 'EUR',
        customerFirstName: 'Anna',
        manageUrl: `${PUBLIC_WEB_ORIGIN}/manage#${TOKEN}`,
        freeCancellationUntil: null,
      },
    }),
  );
}

/** Rebuild the app so a settings change is seen — settings are cached at bootstrap. */
async function withSettings(data: Record<string, unknown>): Promise<void> {
  await prisma.organizationSettings.updateMany({ data });
  await testApp.close();
  await build();
}

async function build(): Promise<void> {
  testApp = await createBookingTestApp({
    organization: await loadOrganization(ctx.organization.id),
    clock,
    extraImports: [WebhooksModule],
  });

  server = testApp.server;
  service = testApp.app.get(NotificationService);
  reconciler = testApp.app.get(NotificationReconciler);
  bookingEvents = testApp.app.get(BookingEventProcessor);
  messagingEvents = testApp.app.get(MessagingEventProcessor);
}

/** A signed Resend webhook, the way Svix signs one. */
function postResend(type: string, data: Record<string, unknown>, svixId = 'msg_1') {
  const body = JSON.stringify({ type, data });
  const timestamp = '1786000000';
  const signature = createHmac('sha256', 'test-resend-secret')
    .update(`${svixId}.${timestamp}.${body}`, 'utf8')
    .digest('hex');

  return request(server())
    .post('/webhooks/resend')
    .set('content-type', 'application/json')
    .set('svix-id', svixId)
    .set('svix-timestamp', timestamp)
    .set('svix-signature', `v1,${signature}`)
    .send(body);
}

/** A signed Twilio webhook, which is form-encoded. */
function postTwilio(fields: Record<string, string>) {
  const body = new URLSearchParams(fields).toString();
  const signature = createHmac('sha256', 'test-twilio-token').update(body, 'utf8').digest('hex');

  return (
    request(server())
      .post('/webhooks/twilio')
      // Form-encoded, which is what Twilio actually posts. Sending it as JSON would fail in
      // the body parser before the signature was ever checked.
      .set('content-type', 'application/x-www-form-urlencoded')
      .set('x-twilio-signature', signature)
      .send(body)
  );
}

beforeEach(async () => {
  await resetDatabase();
  ctx = await seedOrganization(prisma);
  clock = new FixedClock(NOW);

  await build();
  bookingId = await confirmedBooking();

  return async () => {
    await testApp.close();
  };
});

describe('queueing', () => {
  it('creates a PENDING row before sending', async () => {
    const { notificationId } = await queueConfirmation();

    const row = await prisma.notification.findUniqueOrThrow({
      where: { id: notificationId ?? '' },
    });
    expect(row).toMatchObject({ status: 'PENDING', channel: 'EMAIL', locale: 'de' });

    // Nothing has left the building yet: the row exists so a crash mid-send leaves
    // something the reconciler can find.
    expect(testApp.email.sent).toHaveLength(0);
  });

  it('records the send job through the outbox', async () => {
    const { notificationId } = await queueConfirmation();

    expect(
      await prisma.outboxEvent.count({
        where: { aggregateId: notificationId ?? '', eventType: 'notification.send' },
      }),
    ).toBe(1);
  });

  it('dedupes a repeated queue for the same booking and kind', async () => {
    await queueConfirmation();

    expect((await queueConfirmation()).notificationId).toBeNull();
    expect(
      await prisma.notification.count({ where: { bookingId, kind: 'BOOKING_CONFIRMATION' } }),
    ).toBe(1);
  });

  it('builds the key from kind, channel, booking and discriminator', () => {
    expect(dedupeKey('REMINDER_24H', 'SMS', 'bk_1', '1786000000')).toBe(
      'REMINDER_24H:SMS:bk_1:1786000000',
    );
    // Absent parts become `-`, so a key is always four fields and never ambiguous.
    expect(dedupeKey('OFFICE_PASSWORD_RESET', 'EMAIL', null)).toBe(
      'OFFICE_PASSWORD_RESET:EMAIL:-:-',
    );
  });

  it('rolls the notification back with the transaction that queued it', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await service.queue(tx, {
          organizationId: ctx.organization.id,
          kind: 'REFUND_ISSUED',
          channel: 'EMAIL',
          locale: 'de',
          recipient: ctx.customer.email,
          bookingId,
          data: {
            businessName: 'x',
            businessPhone: 'x',
            addressLine: 'x',
            businessEmail: 'x@y.z',
            reference: 'SF-X',
            serviceName: 'x',
            employeeName: 'x',
            startsAt: SLOT_FRIDAY_0900,
            endsAt: SLOT_FRIDAY_0900,
            priceCents: 100,
            currency: 'EUR',
            customerFirstName: 'Anna',
            refundedCents: 100,
          },
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    // A message about something that never happened would otherwise be queued.
    expect(await prisma.notification.count({ where: { kind: 'REFUND_ISSUED' } })).toBe(0);
  });
});

describe('sending', () => {
  it('sends, stores the provider id and moves to SENT', async () => {
    const { notificationId } = await queueConfirmation();

    expect(await service.send(notificationId ?? '')).toBe('SENT');

    const row = await prisma.notification.findUniqueOrThrow({
      where: { id: notificationId ?? '' },
    });
    expect(row.status).toBe('SENT');
    expect(row.providerMessageId).toBeTruthy();
    expect(row.sentAt).toEqual(NOW);
    expect(row.subject).toContain('Termin bestätigt');

    expect(testApp.email.sent[0]).toMatchObject({ to: ctx.customer.email, locale: 'de' });
    expect(testApp.email.sent[0]?.subject).toContain('Termin bestätigt');
  });

  it('renders from the frozen payload, not from current state', async () => {
    const { notificationId } = await queueConfirmation();

    // The service is renamed after queueing. The email must still say what the customer
    // was told when they booked.
    await prisma.service.update({
      where: { id: ctx.service30.id },
      data: { name: 'Umbenannt' },
    });

    await service.send(notificationId ?? '');

    expect(testApp.email.sent[0]?.text).toContain(ctx.service30.name);
    expect(testApp.email.sent[0]?.text).not.toContain('Umbenannt');
  });

  it('revives dates out of the stored payload', async () => {
    const { notificationId } = await queueConfirmation();
    await service.send(notificationId ?? '');

    // The payload round-tripped through JSON, so a Date became a string. If it were not
    // revived the template would render `[object Object]` or the raw ISO string.
    expect(testApp.email.sent[0]?.text).toContain('09:00');
    expect(testApp.email.sent[0]?.text).toContain('14.08.2026');
  });

  it('does nothing for a notification already sent', async () => {
    const { notificationId } = await queueConfirmation();
    await service.send(notificationId ?? '');

    expect(await service.send(notificationId ?? '')).toBe('SENT');
    expect(testApp.email.sent).toHaveLength(1);
  });

  it('marks FAILED on a permanent provider error', async () => {
    const { notificationId } = await queueConfirmation();
    testApp.email.failNextWith(Object.assign(new Error('invalid recipient'), { status: 422 }));

    expect(await service.send(notificationId ?? '')).toBe('FAILED');

    const row = await prisma.notification.findUniqueOrThrow({
      where: { id: notificationId ?? '' },
    });
    expect(row.status).toBe('FAILED');
    expect(row.failedAt).toEqual(NOW);
    expect(row.lastError).toContain('invalid recipient');
    expect(row.attempts).toBe(1);
  });

  it('rethrows a transient error and leaves the row PENDING for the retry', async () => {
    const { notificationId } = await queueConfirmation();
    testApp.email.failNextWith(Object.assign(new Error('gateway'), { status: 503 }));

    await expect(service.send(notificationId ?? '')).rejects.toThrow('gateway');

    const row = await prisma.notification.findUniqueOrThrow({
      where: { id: notificationId ?? '' },
    });
    // Giving up on a 503 would lose a message that would have gone through a minute later.
    expect(row.status).toBe('PENDING');
    expect(row.attempts).toBe(1);
  });

  it('treats an error with no status as transient', async () => {
    const { notificationId } = await queueConfirmation();
    testApp.email.failNextWith(new Error('ECONNRESET'));

    // A socket error, a timeout, a DNS failure: the provider never answered.
    await expect(service.send(notificationId ?? '')).rejects.toThrow('ECONNRESET');
  });
});

describe('one booking.confirmed event', () => {
  it('produces a customer email and an office email', async () => {
    await bookingEvents.confirmed({
      organizationId: ctx.organization.id,
      bookingId,
      managementToken: TOKEN,
    });

    const kinds = (await prisma.notification.findMany({ where: { bookingId } }))
      .map((row) => row.kind)
      .sort();

    expect(kinds).toEqual(['BOOKING_CONFIRMATION', 'OFFICE_NEW_BOOKING']);
  });

  it('puts the management link in the customer email and not the office one', async () => {
    await bookingEvents.confirmed({
      organizationId: ctx.organization.id,
      bookingId,
      managementToken: TOKEN,
    });

    const rows = await prisma.notification.findMany({ where: { bookingId } });
    for (const row of rows) await service.send(row.id);

    // The seeded customer's stored address is mixed-case; the recipient is whatever the
    // row holds, not a normalised copy.
    const customerEmail = ctx.customer.email;
    const customer = testApp.email.lastTo(customerEmail);
    const office = testApp.email.sent.find((mail) => mail.to !== customerEmail);

    // In the fragment, so the token never reaches a server log or a Referer header.
    expect(customer?.text).toContain(`/manage#${TOKEN}`);
    expect(office?.text).not.toContain(TOKEN);
  });

  it('produces the same two notifications when processed twice', async () => {
    const payload = {
      organizationId: ctx.organization.id,
      bookingId,
      managementToken: TOKEN,
    };

    await bookingEvents.confirmed(payload);
    await bookingEvents.confirmed(payload);

    // At-least-once job delivery, effectively-once contact. The second run's queue calls
    // hit the unique index and return null.
    expect(await prisma.notification.count({ where: { bookingId } })).toBe(2);
  });

  it('adds an SMS only when enabled and a number exists', async () => {
    await withSettings({ smsRemindersEnabled: false });

    await bookingEvents.confirmed({
      organizationId: ctx.organization.id,
      bookingId,
      managementToken: TOKEN,
    });
    expect(await prisma.notification.count({ where: { bookingId, channel: 'SMS' } })).toBe(0);

    await prisma.notification.deleteMany({ where: { bookingId } });
    await withSettings({ smsRemindersEnabled: true });

    await bookingEvents.confirmed({
      organizationId: ctx.organization.id,
      bookingId,
      managementToken: TOKEN,
    });
    expect(await prisma.notification.count({ where: { bookingId, channel: 'SMS' } })).toBe(1);
  });

  it('omits the SMS when the customer gave no number', async () => {
    await withSettings({ smsRemindersEnabled: true });
    await prisma.customer.updateMany({ data: { phone: null } });

    await bookingEvents.confirmed({
      organizationId: ctx.organization.id,
      bookingId,
      managementToken: TOKEN,
    });

    // Sending to a missing number is a provider error, not a message.
    expect(await prisma.notification.count({ where: { bookingId, channel: 'SMS' } })).toBe(0);
  });

  it('does nothing for a booking that no longer exists', async () => {
    await expect(
      bookingEvents.confirmed({
        organizationId: ctx.organization.id,
        bookingId: 'cms9gryv30000ja32145w5gke',
        managementToken: TOKEN,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('other booking events', () => {
  it('tells the customer about their own cancellation, with the amounts', async () => {
    await prisma.booking.update({
      where: { id: bookingId },
      data: { status: 'CANCELED_BY_CUSTOMER', canceledAt: NOW },
    });
    const payment = await prisma.payment.findFirstOrThrow({ where: { bookingId } });
    await prisma.refund.create({
      data: {
        organizationId: ctx.organization.id,
        bookingId,
        paymentId: payment.id,
        amountCents: 3500,
        currency: 'EUR',
        status: 'SUCCEEDED',
        reason: 'CUSTOMER_CANCELLATION',
        idempotencyKey: 'test-key-1',
      },
    });

    await bookingEvents.canceled({ organizationId: ctx.organization.id, bookingId });

    const row = await prisma.notification.findFirstOrThrow({ where: { bookingId } });
    expect(row.kind).toBe('BOOKING_CANCELED_BY_CUSTOMER');

    await service.send(row.id);
    // 4500 paid, 3500 back, so 1000 retained — both numbers read from the rows.
    expect(testApp.email.sent[0]?.text).toContain('35,00');
    expect(testApp.email.sent[0]?.text).toContain('10,00');
  });

  it('uses the business template when the business cancelled', async () => {
    await prisma.booking.update({
      where: { id: bookingId },
      data: { status: 'CANCELED_BY_BUSINESS', canceledAt: NOW, cancellationReason: 'Krankheit' },
    });

    await bookingEvents.canceled({ organizationId: ctx.organization.id, bookingId });

    expect((await prisma.notification.findFirstOrThrow({ where: { bookingId } })).kind).toBe(
      'BOOKING_CANCELED_BY_BUSINESS',
    );
  });

  it('tells the customer a refund is on its way, once per refund', async () => {
    const payment = await prisma.payment.findFirstOrThrow({ where: { bookingId } });
    const refund = await prisma.refund.create({
      data: {
        organizationId: ctx.organization.id,
        bookingId,
        paymentId: payment.id,
        amountCents: 2000,
        currency: 'EUR',
        status: 'SUCCEEDED',
        reason: 'GOODWILL',
        idempotencyKey: 'test-key-2',
      },
    });

    await bookingEvents.refundSucceeded({
      organizationId: ctx.organization.id,
      refundId: refund.id,
    });
    await bookingEvents.refundSucceeded({
      organizationId: ctx.organization.id,
      refundId: refund.id,
    });

    expect(await prisma.notification.count({ where: { bookingId, kind: 'REFUND_ISSUED' } })).toBe(
      1,
    );
  });

  it('gives two partial refunds on one booking their own messages', async () => {
    const payment = await prisma.payment.findFirstOrThrow({ where: { bookingId } });

    for (const [index, amount] of [1000, 1500].entries()) {
      const refund = await prisma.refund.create({
        data: {
          organizationId: ctx.organization.id,
          bookingId,
          paymentId: payment.id,
          amountCents: amount,
          currency: 'EUR',
          status: 'SUCCEEDED',
          reason: 'GOODWILL',
          idempotencyKey: `test-key-partial-${String(index)}`,
        },
      });

      await bookingEvents.refundSucceeded({
        organizationId: ctx.organization.id,
        refundId: refund.id,
      });
    }

    // The discriminator is the refund id, so the second is not deduped into the first.
    expect(await prisma.notification.count({ where: { bookingId, kind: 'REFUND_ISSUED' } })).toBe(
      2,
    );
  });
});

describe('POST /webhooks/resend', () => {
  it('marks a delivered email DELIVERED', async () => {
    const { notificationId } = await queueConfirmation();
    await service.send(notificationId ?? '');
    const row = await prisma.notification.findUniqueOrThrow({
      where: { id: notificationId ?? '' },
    });

    await postResend('email.delivered', { email_id: row.providerMessageId }).expect(200);
    await messagingEvents.handle({ provider: 'RESEND', providerEventId: 'msg_1' });

    expect(
      (await prisma.notification.findUniqueOrThrow({ where: { id: notificationId ?? '' } })).status,
    ).toBe('DELIVERED');
  });

  it('marks a bounced email FAILED', async () => {
    const { notificationId } = await queueConfirmation();
    await service.send(notificationId ?? '');
    const row = await prisma.notification.findUniqueOrThrow({
      where: { id: notificationId ?? '' },
    });

    await postResend('email.bounced', { email_id: row.providerMessageId }).expect(200);
    await messagingEvents.handle({ provider: 'RESEND', providerEventId: 'msg_1' });

    const after = await prisma.notification.findUniqueOrThrow({
      where: { id: notificationId ?? '' },
    });
    expect(after.status).toBe('FAILED');
    expect(after.lastError).toContain('bounced');
  });

  it('rejects an unsigned request', async () => {
    await request(server())
      .post('/webhooks/resend')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ type: 'email.delivered' }))
      .expect(400);

    expect(await prisma.messagingWebhookEvent.count()).toBe(0);
  });

  it('rejects a request with a wrong signature', async () => {
    await request(server())
      .post('/webhooks/resend')
      .set('content-type', 'application/json')
      .set('svix-id', 'msg_x')
      .set('svix-timestamp', '1786000000')
      .set('svix-signature', 'v1,deadbeef')
      .send(JSON.stringify({ type: 'email.delivered' }))
      .expect(400);
  });

  it('returns 200 for a duplicate delivery without a second row', async () => {
    await postResend('email.delivered', { email_id: 'email_x' }).expect(200);
    await postResend('email.delivered', { email_id: 'email_x' }).expect(200);

    expect(await prisma.messagingWebhookEvent.count()).toBe(1);
  });
});

describe('POST /webhooks/twilio', () => {
  it('marks an undelivered SMS FAILED with the error code', async () => {
    await withSettings({ smsRemindersEnabled: true });
    await bookingEvents.confirmed({
      organizationId: ctx.organization.id,
      bookingId,
      managementToken: TOKEN,
    });

    const smsRow = await prisma.notification.findFirstOrThrow({
      where: { bookingId, channel: 'SMS' },
    });
    await service.send(smsRow.id);
    const sent = await prisma.notification.findUniqueOrThrow({ where: { id: smsRow.id } });

    await postTwilio({
      MessageSid: sent.providerMessageId ?? '',
      MessageStatus: 'undelivered',
      ErrorCode: '30003',
    }).expect(200);

    await messagingEvents.handle({
      provider: 'TWILIO',
      providerEventId: `${sent.providerMessageId ?? ''}:undelivered`,
    });

    const after = await prisma.notification.findUniqueOrThrow({ where: { id: smsRow.id } });
    expect(after.status).toBe('FAILED');
    // The code is where a support conversation with Twilio starts.
    expect(after.lastError).toContain('30003');
  });

  it('rejects an unsigned request', async () => {
    await request(server())
      .post('/webhooks/twilio')
      .set('content-type', 'application/x-www-form-urlencoded')
      .send('MessageSid=x')
      .expect(400);
  });

  it('keeps sent and delivered as distinct events', async () => {
    await postTwilio({ MessageSid: 'SM1', MessageStatus: 'sent' }).expect(200);
    await postTwilio({ MessageSid: 'SM1', MessageStatus: 'delivered' }).expect(200);

    // The same message reports both, and deduplicating them into one would lose the
    // verdict.
    expect(await prisma.messagingWebhookEvent.count()).toBe(2);
  });
});

describe('delivery status that cannot be applied', () => {
  it('ignores a verdict for an unknown provider id', async () => {
    await expect(
      service.applyDeliveryStatus({ providerMessageId: 'email_nobody', delivered: true }),
    ).resolves.toBeUndefined();
  });

  it('does not flip a row that has already settled', async () => {
    const { notificationId } = await queueConfirmation();
    await service.send(notificationId ?? '');
    const row = await prisma.notification.findUniqueOrThrow({
      where: { id: notificationId ?? '' },
    });

    await service.applyDeliveryStatus({
      providerMessageId: row.providerMessageId ?? '',
      delivered: true,
    });
    await service.applyDeliveryStatus({
      providerMessageId: row.providerMessageId ?? '',
      delivered: false,
      error: 'late failure',
    });

    // Twilio sends `sent` then `delivered`, and occasionally a late failure.
    expect(
      (await prisma.notification.findUniqueOrThrow({ where: { id: notificationId ?? '' } })).status,
    ).toBe('DELIVERED');
  });
});

describe('the reconciler', () => {
  it('re-enqueues notifications stalled past the window', async () => {
    const { notificationId } = await queueConfirmation();
    await prisma.notification.updateMany({
      where: { id: notificationId ?? '' },
      data: { createdAt: new Date(NOW.getTime() - NOTIFICATION_STALLED_AFTER_MS - 60_000) },
    });

    enqueued.length = 0;
    expect(await reconciler.runOnce()).toBe(1);
    expect(enqueued[0]).toMatchObject({ name: 'notification.send' });
  });

  it('leaves a fresh notification alone', async () => {
    await queueConfirmation();
    expect(await reconciler.runOnce()).toBe(0);
  });

  it('leaves one that already went out', async () => {
    const { notificationId } = await queueConfirmation();
    await service.send(notificationId ?? '');
    await prisma.notification.updateMany({
      data: { createdAt: new Date(NOW.getTime() - NOTIFICATION_STALLED_AFTER_MS - 60_000) },
    });

    expect(await reconciler.runOnce()).toBe(0);
  });

  it('reports counts per state', async () => {
    const { notificationId } = await queueConfirmation();
    await prisma.notification.updateMany({
      where: { id: notificationId ?? '' },
      data: { createdAt: new Date(NOW.getTime() - NOTIFICATION_STALLED_AFTER_MS - 60_000) },
    });

    expect(await reconciler.health()).toEqual({ pending: 1, stalled: 1, failed: 0 });
  });

  it('redacts the recipient and subject past ninety days, keeping the row', async () => {
    const { notificationId } = await queueConfirmation();
    await service.send(notificationId ?? '');
    await prisma.notification.updateMany({
      data: { createdAt: new Date(NOW.getTime() - 91 * 86_400_000) },
    });

    expect(await reconciler.redactOld()).toBe(1);

    const row = await prisma.notification.findUniqueOrThrow({
      where: { id: notificationId ?? '' },
    });
    // The delivery statistics stay useful for years; the address stops being needed as
    // soon as anyone might have asked about that specific message.
    expect(row.recipient).toBe(REDACTED);
    expect(row.subject).toBeNull();
    expect(row.status).toBe('SENT');
  });

  it('does not redact twice, so the count means newly redacted', async () => {
    const { notificationId } = await queueConfirmation();
    await service.send(notificationId ?? '');
    await prisma.notification.updateMany({
      data: { createdAt: new Date(NOW.getTime() - 91 * 86_400_000) },
    });

    expect(await reconciler.redactOld()).toBe(1);
    expect(await reconciler.redactOld()).toBe(0);
  });
});
