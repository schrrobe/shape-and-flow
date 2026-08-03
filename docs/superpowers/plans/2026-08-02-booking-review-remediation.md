# Booking Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve all 16 review findings while preserving booking, payment, notification, authentication, and audit invariants under retries and concurrency.

**Architecture:** Reservation acceptance will bind the active employee-service assignment, authoritative price, hold, idempotency key, and expiry schedule before Checkout. Reschedule chains will share a constant-time financial root, and every refund producer will reserve balance through one locked transaction path. Request notifications, worker settings refresh, web draft transitions, login lockout, and audits will use their existing durable abstractions rather than route-local workarounds.

**Tech Stack:** Node.js 24.18, TypeScript 6, NestJS 11, Prisma 7/PostgreSQL 17, BullMQ/Redis 7, Vue 3/Pinia, Vitest, Supertest, Playwright, pnpm 10.

## Global Constraints

- Prefix every shell command with `rtk` as required by the repository instructions.
- Preserve all pre-existing uncommitted changes. Before each task, run `rtk git diff -- <files>`; stage only new task hunks with `rtk git add -p -- <files>` when a file already contains user changes.
- Do not add dependencies. Use the existing Prisma, NestJS, BullMQ, Vue, Pinia, Vitest, and Playwright facilities.
- Do not call Stripe, email, SMS, or another provider inside a database transaction.
- Keep tenant selection server-side through `OrganizationContextService`; never accept an organization ID from public input.
- Use `Money` for cent arithmetic. Do not introduce bare subtraction for prices, paid totals, retained amounts, or refundable balances.
- Public assignment failures must not distinguish an unknown employee, archived employee, hidden employee, or missing service pairing.
- `notification.send` may only reference a committed `Notification` row created through `NotificationService.queue()`.
- `customerNotificationAlreadyQueued` is optional in job payloads and defaults to `false` for rolling-deployment compatibility.
- `financialRootBookingId` is nullable; null means the booking is its own financial root.
- Successful plus pending refunds must never exceed the provider payment amount.
- Existing API and worker entrypoints remain separate processes.
- Every behavioral change starts with a regression test that fails for the reported reason, then passes after the minimal implementation.
- Each task receives a task-scoped review before the next dependent task begins.

## File and dependency map

- `reservation.service.ts` owns authoritative assignment validation, price snapshotting, and reservation/idempotency binding.
- `idempotency.service.ts` owns retry lease state; `public-bookings.controller.ts` chooses resume versus reserve; `booking-checkout.service.ts` owns idempotent session attachment.
- `request-notification.service.ts` will compose request-specific notification rows; `NotificationService` remains the only row/job writer.
- `booking-financials.service.ts` will resolve and batch-load the stable financial root; readers and money writers consume it.
- `refund.service.ts` will own all pending-refund reservation and remaining-balance validation.
- `cancellation.service.ts` will supply business policy targets, not duplicate refund persistence.
- `auth.controller.ts` will serialize failed-attempt increments and condition successful resets.
- `worker-registrar.service.ts` will refresh organization policy before each job scope.
- `booking-draft.ts` will own persisted choice and attempt lifecycle transitions; pages only invoke them.
- Transactional booking services keep their audits; interceptor-owned routes declare their response ID field.

The tasks are ordered by dependency. Tasks 7–10 are independent of the financial sequence but remain after it in this plan so the final integration review sees one coherent branch.

## Review-finding traceability

| Review finding                                          | Implemented by | Regression proof                                              |
| ------------------------------------------------------- | -------------- | ------------------------------------------------------------- |
| Employee-specific price ignored                         | Task 1         | Override and zero-price reservation/public Checkout tests     |
| Explicit employee assignment not validated              | Task 1         | Unassigned, hidden, and archived employee rejection tests     |
| Request alerts reference no notification row            | Task 3         | Cancellation/reschedule send-event foreign-row tests          |
| Reschedule loses payment access                         | Tasks 4–5      | Two-reschedule manage, office, export, and notification tests |
| Failed-login increments race                            | Task 7         | Parallel threshold-crossing login test                        |
| Checkout failure strands a reservation                  | Task 2         | Same-key provider and attachment-gap retry tests              |
| Worker settings stay stale                              | Task 8         | Independent worker-cache refresh test                         |
| Cancellation over-refunds a partially refunded charge   | Task 6         | Cumulative-target cancellation test                           |
| Rejected requests do not notify customers               | Task 3         | Both rejected decision-kind tests                             |
| Pending refunds are excluded from balance               | Task 6         | Concurrent/sequential pending-refund balance tests            |
| Refund permission checks omitted retained value as zero | Task 6         | Full-retention omitted-body authorization test                |
| Explicit “any employee” is not persisted                | Task 9         | Store reconstruction test                                     |
| Expired Checkout reuses a completed key                 | Task 9         | Expiry rotates-key test and public browser journey            |
| Success page loses confirmation email                   | Task 9         | Confirmed-page snapshot/reset test                            |
| Transactional routes duplicate audit rows               | Task 10        | Exact-one audit assertions for five routes                    |
| Audit rows use the wrong entity ID                      | Task 10        | Manual-booking and refund response-ID assertions              |

---

### Task 1: Enforce employee assignment and effective price

**Files:**

- Modify: `booking-app/apps/api/src/booking/reservation.service.ts:139-458`
- Modify: `booking-app/apps/api/src/domain/pricing/pricing.ts:1-35` only if its exported input type needs widening
- Test: `booking-app/apps/api/test/integration/reservation.int.spec.ts`
- Test: `booking-app/apps/api/test/integration/public-bookings.int.spec.ts`

**Interfaces:**

- Consumes: `resolveEffectivePrice(service, assignment): Money` from `domain/pricing/pricing.ts`.
- Produces: `ReservationService.reserve()` returning a `ReserveResult` whose `booking.priceCentsSnapshot` and `price` are derived from the same active `EmployeeService` row.
- Produces: a private transaction-scoped projection containing `employeeId`, `displayName`, `priceOverrideCents`, service `priceCents`, and `currency`.

- [ ] **Step 1: Add failing assignment and price regression tests**

Add these cases to `reservation.int.spec.ts`:

```ts
it("snapshots the resolved employee price override", async () => {
  await prisma.employeeService.update({
    where: {
      employeeId_serviceId: {
        employeeId: ctx.employee1.id,
        serviceId: ctx.service30.id,
      },
    },
    data: { priceOverrideCents: 9900 },
  });

  const { booking, price } = await service.reserve(input());

  expect(booking.priceCentsSnapshot).toBe(9900);
  expect(price.amountCents).toBe(9900);
});

it.each([
  [
    "unassigned",
    async () =>
      prisma.employeeService.deleteMany({
        where: { employeeId: ctx.employee1.id, serviceId: ctx.service30.id },
      }),
  ],
  [
    "hidden",
    async () =>
      prisma.employee.update({
        where: { id: ctx.employee1.id },
        data: { isBookableOnline: false },
      }),
  ],
  [
    "archived",
    async () =>
      prisma.employee.update({
        where: { id: ctx.employee1.id },
        data: { archivedAt: NOW },
      }),
  ],
])("rejects an explicitly requested %s employee", async (_label, arrange) => {
  await arrange();
  await expect(service.reserve(input())).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  expect(await prisma.booking.count()).toBe(0);
  expect(await prisma.customer.count()).toBe(0);
});
```

Add a public route case that asserts the response, booking snapshot, and pending payment all equal `9900`.

- [ ] **Step 2: Run the focused tests and confirm the reported failures**

Run:

```bash
rtk pnpm --filter @shape-and-flow/booking-api exec vitest run --config vitest.integration.config.ts test/integration/reservation.int.spec.ts test/integration/public-bookings.int.spec.ts
```

Expected: the override test receives the base price, and the unassigned/hidden/archived explicit employee cases create or attempt a booking instead of returning `NOT_FOUND`.

- [ ] **Step 3: Add one transaction-scoped assignment-and-price lookup**

Import `resolveEffectivePrice` and add a helper with this contract:

```ts
private async loadEffectiveAssignment(
  tx: Prisma.TransactionClient,
  input: { organizationId: string; serviceId: string; employeeId: string; actor: ReserveActor },
): Promise<{ employee: { id: string; displayName: string }; price: Money }> {
  const assignment = await tx.employeeService.findFirst({
    where: {
      organizationId: input.organizationId,
      serviceId: input.serviceId,
      employeeId: input.employeeId,
      employee: {
        archivedAt: null,
        ...(input.actor.type === 'CUSTOMER' ? { isBookableOnline: true } : {}),
      },
      service: { archivedAt: null },
    },
    select: {
      priceOverrideCents: true,
      employee: { select: { id: true, displayName: true } },
      service: { select: { priceCents: true, currency: true } },
    },
  });

  if (assignment === null) throw new AppError('NOT_FOUND', { message: 'Service not found.' });
  return {
    employee: assignment.employee,
    price: resolveEffectivePrice(assignment.service, assignment),
  };
}
```

Call it after `loadForSlot()` succeeds and before customer creation. Use its `price` for `priceCentsSnapshot` and both `ReserveResult` branches. Remove the later employee lookup that checks only organization and ID.

- [ ] **Step 4: Cover zero and “any employee” overrides**

Add assertions showing `priceOverrideCents: 0` remains zero and an `employeeId: null` reservation uses the override belonging to the employee actually selected:

```ts
const result = await service.reserve(input({ employeeId: null }));
const assignment = await prisma.employeeService.findUniqueOrThrow({
  where: {
    employeeId_serviceId: {
      employeeId: result.employee.id,
      serviceId: ctx.service30.id,
    },
  },
});
expect(result.price.amountCents).toBe(
  assignment.priceOverrideCents ?? ctx.service30.priceCents,
);
```

- [ ] **Step 5: Run focused tests, typecheck, and inspect the overlapping user diff**

```bash
rtk pnpm --filter @shape-and-flow/booking-api exec vitest run --config vitest.integration.config.ts test/integration/reservation.int.spec.ts test/integration/public-bookings.int.spec.ts
rtk pnpm --filter @shape-and-flow/booking-api typecheck
rtk git diff -- booking-app/apps/api/src/booking/reservation.service.ts
```

Expected: focused tests pass, typecheck exits 0, and the existing `asOfficeSnapshot` extraction remains present.

- [ ] **Step 6: Commit only Task 1 hunks**

```bash
rtk git add -p -- booking-app/apps/api/src/booking/reservation.service.ts booking-app/apps/api/src/domain/pricing/pricing.ts booking-app/apps/api/test/integration/reservation.int.spec.ts booking-app/apps/api/test/integration/public-bookings.int.spec.ts
rtk git diff --cached --check
rtk git commit -m "fix(booking): honor employee assignment price"
```

### Task 2: Resume a bound reservation after Checkout failure

**Files:**

- Modify: `booking-app/apps/api/src/messaging/idempotency/idempotency.service.ts:36-205`
- Modify: `booking-app/apps/api/src/messaging/idempotency/idempotency.interceptor.ts:75-110`
- Modify: `booking-app/apps/api/src/booking/reservation.service.ts:53-458`
- Modify: `booking-app/apps/api/src/booking/booking-checkout.service.ts:41-131`
- Modify: `booking-app/apps/api/src/public/public-bookings.controller.ts:45-202`
- Modify: `booking-app/apps/api/src/providers/payment/fake-payment.provider.ts`
- Modify: `booking-app/apps/api/src/providers/payment/fake-payment.store.ts`
- Test: `booking-app/apps/api/test/integration/public-bookings.int.spec.ts`
- Test: `booking-app/apps/api/test/integration/idempotency.int.spec.ts`
- Test: `booking-app/apps/api/test/integration/expiry-saga.int.spec.ts`

**Interfaces:**

- Consumes: Task 1's authoritative `ReserveResult` price.
- Produces: optional `ReserveInput.idempotencyKey?: string` for public reservations.
- Produces: `ReservationService.resume(idempotencyKey): Promise<ReserveResult | null>`.
- Produces: `IdempotencyService.abandon()` semantics that delete unbound keys and immediately release the lease on bound keys.
- Produces: idempotent `BookingCheckoutService.attach()` for an identical booking/session pair.

- [ ] **Step 1: Add failing retry and expiry tests**

Replace the existing “keeps the reservation” provider-failure assertion with an immediate retry:

```ts
it("resumes the same reservation after Checkout fails", async () => {
  const key = randomUUID();
  payments.failNextWith(new Error("ECONNRESET"));

  await post(body(), key).expect(502);
  const held = await prisma.booking.findFirstOrThrow();

  const retried = await post(body(), key).expect(201);
  expect((retried.body as { bookingId: string }).bookingId).toBe(held.id);
  expect(await prisma.booking.count()).toBe(1);
  expect(await prisma.payment.count()).toBe(1);
  expect(await payments.sessions()).toHaveLength(1);
});

it("arms expiry before Checkout answers", async () => {
  payments.failNextWith(new Error("ECONNRESET"));
  await post().expect(502);
  const held = await prisma.booking.findFirstOrThrow();
  expect(
    await prisma.outboxEvent.count({
      where: { aggregateId: held.id, eventType: JOB.BOOKING_EXPIRY_REQUESTED },
    }),
  ).toBe(1);
});
```

Add an attachment-gap regression using a narrow test-only cast (do not widen production visibility):

```ts
const checkout = app.get(BookingCheckoutService);
const attach = vi.spyOn(
  checkout as unknown as {
    attach(booking: Booking, sessionId: string): Promise<void>;
  },
  "attach",
);
attach.mockRejectedValueOnce(
  new Error("database unavailable after provider response"),
);

await post(body(), key).expect(502);
const firstSession = (await payments.sessions())[0];
expect(firstSession).toBeDefined();

const retried = await post(body(), key).expect(201);
expect(retried.body.checkoutUrl).toBe(firstSession?.url);
expect(await prisma.booking.count()).toBe(1);
expect(await prisma.payment.count()).toBe(1);
```

- [ ] **Step 2: Run the focused retry suites and verify failure**

```bash
rtk pnpm --filter @shape-and-flow/booking-api exec vitest run --config vitest.integration.config.ts test/integration/public-bookings.int.spec.ts test/integration/idempotency.int.spec.ts test/integration/expiry-saga.int.spec.ts
```

Expected: immediate retry returns `SLOT_UNAVAILABLE`, and the failed reservation has no booking-specific expiry event.

- [ ] **Step 3: Bind the claimed key inside the reservation transaction**

Extend `ReserveInput` and the booking insert:

```ts
const claimedKey = input.idempotencyKey === undefined
  ? null
  : await tx.idempotencyKey.findFirst({
      where: { key: input.idempotencyKey, scope: 'booking.create', state: 'IN_PROGRESS' },
      select: { id: true },
    });

if (input.idempotencyKey !== undefined && claimedKey === null) {
  throw new AppError('IDEMPOTENCY_KEY_REUSED', { message: 'Booking attempt is not claimable.' });
}

// booking.create data
...(claimedKey === null ? {} : { idempotencyKeyId: claimedKey.id }),

if (claimedKey !== null) {
  await tx.idempotencyKey.update({ where: { id: claimedKey.id }, data: { bookingId: booking.id } });
}
```

Record `BOOKING_EXPIRY_REQUESTED` in this transaction for customer reservations and remove duplicate scheduling from Checkout attachment.

- [ ] **Step 4: Preserve bound leases and expose reservation resume**

Change `IdempotencyService.abandon(key)` to perform these two writes:

```ts
await this.prisma.$transaction([
  this.prisma.idempotencyKey.deleteMany({
    where: { key, state: IDEMPOTENCY_STATE.IN_PROGRESS, bookingId: null },
  }),
  this.prisma.idempotencyKey.updateMany({
    where: {
      key,
      state: IDEMPOTENCY_STATE.IN_PROGRESS,
      bookingId: { not: null },
    },
    data: { expiresAt: this.clock.now() },
  }),
]);
```

Implement `ReservationService.resume()` with the same tenant and expiry rules as `reserve()`:

```ts
async resume(idempotencyKey: string): Promise<ReserveResult | null> {
  const organizationId = this.organizations.getOrganizationId();
  const now = this.clock.now();
  const claimed = await this.prisma.idempotencyKey.findFirst({
    where: {
      key: idempotencyKey,
      scope: 'booking.create',
      booking: {
        organizationId,
        status: BookingStatus.PENDING_PAYMENT,
        expiresAt: { gt: now },
      },
    },
    select: {
      booking: {
        select: {
          ...RESUMABLE_BOOKING,
          employee: { select: { id: true, displayName: true } },
        },
      },
    },
  });

  if (claimed?.booking === null || claimed?.booking === undefined) return null;
  return {
    booking: claimed.booking,
    employee: claimed.booking.employee,
    price: Money.fromCents(claimed.booking.priceCentsSnapshot, claimed.booking.currency),
  };
}
```

Define `RESUMABLE_BOOKING` with every scalar required by the generated `Booking` return type and use Prisma's `satisfies Prisma.BookingSelect` check so this projection cannot silently drift.

- [ ] **Step 5: Resume before reserve and make attachment idempotent**

In `PublicBookingsController.create()`:

```ts
const reserved =
  (await this.reservations.resume(idempotencyKey)) ??
  (await this.reservations.reserve({
    serviceId: body.serviceId,
    employeeId: body.employeeId ?? null,
    startsAt: new Date(body.startsAt),
    customer: { ...body.customer, locale: body.locale },
    locale: body.locale,
    idempotencyKey,
    ...(body.customerNote === undefined
      ? {}
      : { customerNote: body.customerNote }),
  }));
```

Inside Checkout attachment, lock the booking and make both halves idempotent:

```ts
await tx.$queryRaw`SELECT id FROM bookings WHERE id = ${booking.id} FOR UPDATE`;
const current = await tx.booking.findUniqueOrThrow({
  where: { id: booking.id },
  select: { stripeCheckoutSessionId: true },
});
if (
  current.stripeCheckoutSessionId !== null &&
  current.stripeCheckoutSessionId !== sessionId
) {
  throw new AppError("INTERNAL_ERROR", {
    message: "Booking already has another Checkout session.",
  });
}
if (current.stripeCheckoutSessionId === null) {
  await tx.booking.update({
    where: { id: booking.id },
    data: { stripeCheckoutSessionId: sessionId },
  });
}
await tx.payment.createMany({
  skipDuplicates: true,
  data: [
    {
      organizationId,
      bookingId: booking.id,
      stripeCheckoutSessionId: sessionId,
      amountCents: booking.priceCentsSnapshot,
      currency: booking.currency,
      status: PaymentStatus.PENDING,
    },
  ],
});
```

After `createMany`, load the payment by `stripeCheckoutSessionId` and assert its booking, amount, and currency match; throw `INTERNAL_ERROR` on a mismatch. Expiry scheduling is no longer part of `attach()` because Step 3 commits it with the reservation.

- [ ] **Step 6: Model a provider response lost after session creation**

Extend the fake payment store with a one-shot `failAfterCheckoutCreate` error. `createCheckoutSession()` must store the idempotent session, then throw once; the retry with the same provider key returns the stored session. Add this assertion:

```ts
payments.failNextCheckoutAfterCreateWith(
  new Error("socket closed after response"),
);
await post(body(), key).expect(502);
const retry = await post(body(), key).expect(201);
expect(await payments.sessions()).toHaveLength(1);
expect((retry.body as { bookingId: string }).bookingId).toBe(
  (await prisma.booking.findFirstOrThrow()).id,
);
```

- [ ] **Step 7: Run retry, expiry, type, and lint verification**

```bash
rtk pnpm --filter @shape-and-flow/booking-api exec vitest run --config vitest.integration.config.ts test/integration/public-bookings.int.spec.ts test/integration/idempotency.int.spec.ts test/integration/expiry-saga.int.spec.ts test/integration/fake-payment-store.int.spec.ts
rtk pnpm --filter @shape-and-flow/booking-api typecheck
rtk pnpm --filter @shape-and-flow/booking-api lint
```

- [ ] **Step 8: Commit Task 2 without absorbing the user's fake-provider work**

```bash
rtk git add -p -- booking-app/apps/api/src/messaging/idempotency/idempotency.service.ts booking-app/apps/api/src/messaging/idempotency/idempotency.interceptor.ts booking-app/apps/api/src/booking/reservation.service.ts booking-app/apps/api/src/booking/booking-checkout.service.ts booking-app/apps/api/src/public/public-bookings.controller.ts booking-app/apps/api/src/providers/payment/fake-payment.provider.ts booking-app/apps/api/src/providers/payment/fake-payment.store.ts booking-app/apps/api/test/integration/public-bookings.int.spec.ts booking-app/apps/api/test/integration/idempotency.int.spec.ts booking-app/apps/api/test/integration/expiry-saga.int.spec.ts booking-app/apps/api/test/integration/fake-payment-store.int.spec.ts
rtk git diff --cached --check
rtk git commit -m "fix(checkout): resume failed booking attempts"
```

### Task 3: Queue real request and decision notifications

**Files:**

- Create: `booking-app/apps/api/src/notification/request-notification.service.ts`
- Modify: `booking-app/apps/api/src/notification/booking-notification-data.service.ts:1-110`
- Modify: `booking-app/apps/api/src/notification/notification.module.ts:1-39`
- Modify: `booking-app/apps/api/src/booking/booking.module.ts:1-54`
- Modify: `booking-app/apps/api/src/booking/cancellation.service.ts:60-570`
- Modify: `booking-app/apps/api/src/booking/reschedule.service.ts:70-455`
- Modify: `booking-app/apps/api/src/messaging/queues/job-contracts.ts:29-160`
- Modify: `booking-app/apps/api/src/notification/processors/booking-event.processor.ts:100-260`
- Modify: `booking-app/packages/notification-templates/src/types.ts:50-70`
- Modify: `booking-app/packages/notification-templates/src/de/index.ts`
- Modify: `booking-app/packages/notification-templates/src/en/index.ts`
- Test: `booking-app/apps/api/test/integration/cancellation.int.spec.ts`
- Test: `booking-app/apps/api/test/integration/reschedule.int.spec.ts`
- Test: `booking-app/apps/api/test/integration/notifications.int.spec.ts`
- Test: `booking-app/apps/api/src/messaging/queues/job-contracts.spec.ts`
- Test: `booking-app/packages/notification-templates/src/templates.spec.ts`
- Update snapshot: `booking-app/packages/notification-templates/src/__snapshots__/templates.spec.ts.snap`

**Interfaces:**

- Produces: injectable `RequestNotificationService` with four transaction-aware queue methods.
- Produces: optional `customerNotificationAlreadyQueued?: boolean` on canceled/rescheduled job payloads.
- Produces: `RESCHEDULE_REQUEST_DECIDED.manageUrl: string | null` template data.

- [ ] **Step 1: Add failing notification-row tests**

After opening cancellation and reschedule requests, assert every send event resolves:

```ts
const events = await prisma.outboxEvent.findMany({
  where: { eventType: JOB.NOTIFICATION_SEND },
});
for (const event of events) {
  const notificationId = (event.payload as { notificationId: string })
    .notificationId;
  await expect(
    prisma.notification.findUniqueOrThrow({ where: { id: notificationId } }),
  ).resolves.toBeDefined();
}
expect(
  await prisma.notification.count({
    where: { bookingId, kind: "CANCELLATION_REQUEST_RECEIVED" },
  }),
).toBe(1);
expect(
  await prisma.notification.count({
    where: { bookingId, kind: "OFFICE_CANCELLATION_REQUEST" },
  }),
).toBe(1);
```

Add rejection assertions for both `*_REQUEST_DECIDED` kinds and approval assertions that exactly one customer outcome row exists.

- [ ] **Step 2: Run request and notification suites to verify failure**

```bash
rtk pnpm --filter @shape-and-flow/booking-api exec vitest run --config vitest.integration.config.ts test/integration/cancellation.int.spec.ts test/integration/reschedule.int.spec.ts test/integration/notifications.int.spec.ts
```

Expected: request outbox payloads point at request IDs with no matching notification, and rejection creates no decision notification.

- [ ] **Step 3: Implement `RequestNotificationService`**

Define these exact methods, all accepting `Prisma.TransactionClient`:

```ts
queueCancellationReceived(tx, input: {
  requestId: string; bookingId: string; suggestedRetainedCents: number; reason: string | null;
}): Promise<void>;
queueRescheduleReceived(tx, input: {
  requestId: string; bookingId: string; requestedStartsAt: Date;
}): Promise<void>;
queueCancellationDecided(tx, input: {
  requestId: string; bookingId: string; approved: boolean;
  retainedCents: number; refundedCents: number; note: string | null;
}): Promise<void>;
queueRescheduleDecided(tx, input: {
  requestId: string; bookingId: string; approved: boolean;
  managementToken?: string; note: string | null;
}): Promise<void>;
```

Update `BookingNotificationData.load(bookingId, tx?)` so the composer reads newly created replacement bookings through the caller's transaction. Queue through `NotificationService.queue()` with discriminators `${requestId}:customer`, `${requestId}:office`, and `${requestId}:decision`.

Each method must call the durable queue, never the outbox directly. The cancellation-received implementation establishes the pattern used by the other three:

```ts
const data = await this.bookingData.load(input.bookingId, tx);
await this.notifications.queue(tx, {
  organizationId: data.organizationId,
  bookingId: input.bookingId,
  customerId: data.customer.id,
  kind: "CANCELLATION_REQUEST_RECEIVED",
  channel: "EMAIL",
  locale: data.customer.locale,
  recipient: data.customer.email,
  dedupeDiscriminator: `${input.requestId}:customer`,
  data: {
    ...data.template,
    reason: input.reason,
    suggestedRetainedAmountCents: input.suggestedRetainedCents,
  },
});
for (const recipient of data.officeRecipients) {
  await this.notifications.queue(tx, {
    organizationId: data.organizationId,
    bookingId: input.bookingId,
    officeUserId: recipient.officeUserId,
    kind: "OFFICE_CANCELLATION_REQUEST",
    channel: "EMAIL",
    locale: recipient.locale,
    recipient: recipient.email,
    dedupeDiscriminator: `${input.requestId}:office:${recipient.officeUserId}`,
    data: { ...data.template, reason: input.reason },
  });
}
```

Use the existing template-data field names returned by `BookingNotificationData`; if the projection currently uses a different local name, rename the projection once rather than adding a second data shape.

- [ ] **Step 4: Replace direct send events in both request services**

Delete the two direct `OutboxRecorder.record(... JOB.NOTIFICATION_SEND ...)` calls. Invoke the received methods after request creation and the decided methods in both rejection and approval branches:

```ts
await this.requestNotifications.queueCancellationReceived(tx, {
  requestId: request.id,
  bookingId: booking.id,
  suggestedRetainedCents: request.suggestedRetainedAmountCents,
  reason: request.reason,
});

await this.requestNotifications.queueCancellationDecided(tx, {
  requestId: request.id,
  bookingId: booking.id,
  approved,
  retainedCents: effectiveRetained.amountCents,
  refundedCents: additionalRefund.amountCents,
  note: input.note ?? null,
});

await this.requestNotifications.queueRescheduleDecided(tx, {
  requestId: request.id,
  bookingId: replacement?.id ?? booking.id,
  approved,
  ...(managementToken === undefined ? {} : { managementToken }),
  note: input.note ?? null,
});
```

Pass the rotated management token on approved reschedule; pass no token on rejection.

- [ ] **Step 5: Suppress duplicate generic customer messages on approval**

Extend both relevant job schemas:

```ts
customerNotificationAlreadyQueued: z.boolean().optional(),
```

Set it to `true` on request approvals. In `BookingEventProcessor`, guard only the generic customer queue call:

```ts
if (job.data.customerNotificationAlreadyQueued !== true) {
  await this.bookingNotifications.queueCustomerCancellation(job.data.bookingId);
}
await this.bookingNotifications.queueOfficeCancellation(job.data.bookingId);
```

Apply the same guard around the reschedule customer call. Keep office notifications, calendar work, and reminder scheduling outside the conditional.

- [ ] **Step 6: Make the rejected-reschedule link nullable and update snapshots**

Change the template input to `manageUrl: string | null` and render the manage-link block only when non-null:

```ts
...(data.manageUrl === null ? [] : [`Manage your booking: ${data.manageUrl}`]),
```

Run:

```bash
rtk pnpm --filter @shape-and-flow/booking-notification-templates test -- -u
rtk pnpm --filter @shape-and-flow/booking-api exec vitest run src/messaging/queues/job-contracts.spec.ts
```

Inspect the snapshot diff to confirm only rejected/approved request-decision copy changed.

- [ ] **Step 7: Run all focused notification verification**

```bash
rtk pnpm --filter @shape-and-flow/booking-api exec vitest run --config vitest.integration.config.ts test/integration/cancellation.int.spec.ts test/integration/reschedule.int.spec.ts test/integration/notifications.int.spec.ts
rtk pnpm --filter @shape-and-flow/booking-notification-templates typecheck
rtk pnpm --filter @shape-and-flow/booking-api typecheck
```

- [ ] **Step 8: Commit Task 3**

```bash
rtk git add -p -- booking-app/apps/api/src/notification booking-app/apps/api/src/booking/booking.module.ts booking-app/apps/api/src/booking/cancellation.service.ts booking-app/apps/api/src/booking/reschedule.service.ts booking-app/apps/api/src/messaging/queues booking-app/apps/api/test/integration/cancellation.int.spec.ts booking-app/apps/api/test/integration/reschedule.int.spec.ts booking-app/apps/api/test/integration/notifications.int.spec.ts booking-app/packages/notification-templates/src
rtk git diff --cached --check
rtk git commit -m "fix(notifications): persist request messages"
```

### Task 4: Add the stable financial root and shared loader

**Files:**

- Modify: `booking-app/apps/api/prisma/schema.prisma:618-686`
- Create: `booking-app/apps/api/prisma/migrations/20260802120000_financial_booking_root/migration.sql`
- Create: `booking-app/apps/api/src/payment/booking-financials.service.ts`
- Modify: `booking-app/apps/api/src/payment/payment.module.ts:1-24`
- Modify: `booking-app/apps/api/src/booking/reschedule.service.ts:205-290`
- Create test: `booking-app/apps/api/test/integration/booking-financials.int.spec.ts`
- Test: `booking-app/apps/api/test/integration/reschedule.int.spec.ts`

**Interfaces:**

- Produces: `Booking.financialRootBookingId: string | null` plus `financialRoot` and `financialDescendants` self-relations.
- Produces: `BookingFinancialsService.rootBookingId(bookingId, tx?): Promise<string>`.
- Produces: `BookingFinancialsService.load(bookingId, tx?): Promise<BookingFinancials>` and `loadMany(bookingIds): Promise<Map<string, BookingFinancials>>`.

- [ ] **Step 1: Add failing one- and two-reschedule root tests**

Add to `reschedule.int.spec.ts`:

```ts
expect(firstReplacement.financialRootBookingId).toBe(originalBookingId);
expect(secondReplacement.financialRootBookingId).toBe(originalBookingId);
```

Create `booking-financials.int.spec.ts` with a root payment, a pending refund, and two descendants, then assert `load()` for each ID returns the same `rootBookingId`, payment ID, and refund ID.

- [ ] **Step 2: Run the focused lineage tests and verify the field/service are absent**

```bash
rtk pnpm --filter @shape-and-flow/booking-api exec vitest run --config vitest.integration.config.ts test/integration/reschedule.int.spec.ts test/integration/booking-financials.int.spec.ts
```

Expected: compile or test failure because `financialRootBookingId` and `BookingFinancialsService` do not exist.

- [ ] **Step 3: Add the Prisma self-relation and migration**

Add to `Booking`:

```prisma
financialRootBookingId String? @map("financial_root_booking_id")
financialRoot Booking? @relation("BookingFinancialRoot", fields: [financialRootBookingId], references: [id], onDelete: Restrict)
financialDescendants Booking[] @relation("BookingFinancialRoot")
@@index([financialRootBookingId])
```

Use this migration SQL:

```sql
ALTER TABLE "bookings" ADD COLUMN "financial_root_booking_id" TEXT;

WITH RECURSIVE booking_roots AS (
  SELECT id AS booking_id, id AS root_id
  FROM "bookings"
  WHERE "rescheduled_from_booking_id" IS NULL
  UNION ALL
  SELECT child.id, booking_roots.root_id
  FROM "bookings" child
  JOIN booking_roots ON child."rescheduled_from_booking_id" = booking_roots.booking_id
)
UPDATE "bookings" booking
SET "financial_root_booking_id" = booking_roots.root_id
FROM booking_roots
WHERE booking.id = booking_roots.booking_id
  AND booking.id <> booking_roots.root_id;

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_financial_root_booking_id_fkey"
  FOREIGN KEY ("financial_root_booking_id") REFERENCES "bookings"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "bookings_financial_root_booking_id_idx"
  ON "bookings"("financial_root_booking_id");
```

Run `rtk pnpm --filter @shape-and-flow/booking-api prisma:generate`.

- [ ] **Step 4: Implement the shared financial loader**

Define explicit projections and this public shape:

```ts
export interface BookingFinancials {
  rootBookingId: string;
  payments: FinancialPayment[];
  manualPayments: FinancialManualPayment[];
  refunds: FinancialRefund[];
}
```

`loadMany()` must first map each requested booking to `financialRootBookingId ?? id`, then issue one query per financial table using the distinct root IDs and group results back to every requested booking. Refunds are selected through `payment.bookingId IN rootIds`, not `Refund.bookingId`, so refunds requested on descendants remain visible.

Use one batched implementation for all consumers:

```ts
async loadMany(bookingIds: string[]): Promise<Map<string, BookingFinancials>> {
  if (bookingIds.length === 0) return new Map();
  const bookings = await this.prisma.booking.findMany({
    where: {
      id: { in: [...new Set(bookingIds)] },
      organizationId: this.organizations.getOrganizationId(),
    },
    select: { id: true, financialRootBookingId: true },
  });
  if (bookings.length !== new Set(bookingIds).size) {
    throw new AppError('NOT_FOUND', { message: 'Booking not found.' });
  }

  const rootByBooking = new Map(
    bookings.map((booking) => [booking.id, booking.financialRootBookingId ?? booking.id]),
  );
  const rootIds = [...new Set(rootByBooking.values())];
  const [payments, manualPayments, refunds] = await Promise.all([
    this.prisma.payment.findMany({ where: { bookingId: { in: rootIds } }, select: FINANCIAL_PAYMENT }),
    this.prisma.manualPayment.findMany({ where: { bookingId: { in: rootIds } }, select: FINANCIAL_MANUAL_PAYMENT }),
    this.prisma.refund.findMany({
      where: { payment: { bookingId: { in: rootIds } } },
      select: { ...FINANCIAL_REFUND, payment: { select: { bookingId: true } } },
    }),
  ]);

  const byRoot = new Map(rootIds.map((rootBookingId) => [
    rootBookingId,
    { rootBookingId, payments: [], manualPayments: [], refunds: [] } satisfies BookingFinancials,
  ]));
  for (const payment of payments) byRoot.get(payment.bookingId)?.payments.push(payment);
  for (const payment of manualPayments) byRoot.get(payment.bookingId)?.manualPayments.push(payment);
  for (const refund of refunds) byRoot.get(refund.payment.bookingId)?.refunds.push(refund);

  return new Map(bookingIds.map((bookingId) => {
    const rootBookingId = rootByBooking.get(bookingId);
    if (rootBookingId === undefined) throw new AppError('NOT_FOUND', { message: 'Booking not found.' });
    return [bookingId, byRoot.get(rootBookingId) ?? emptyFinancials(rootBookingId)];
  }));
}

async load(bookingId: string, tx?: Prisma.TransactionClient): Promise<BookingFinancials> {
  if (tx === undefined) return (await this.loadMany([bookingId])).get(bookingId)!;
  return await this.loadWithClient(tx, bookingId);
}
```

Implement `loadWithClient()` with the same three projections against `tx`; implement `rootBookingId()` from the same tenant-scoped identity query. Strip the helper-only nested `payment` property before returning each `FinancialRefund`.

- [ ] **Step 5: Copy the root when rescheduling**

Select `financialRootBookingId` in `RESCHEDULABLE` and set:

```ts
financialRootBookingId: booking.financialRootBookingId ?? booking.id,
```

Do not update existing payment, manual-payment, or refund rows during reschedule.

- [ ] **Step 6: Apply migration to test DB and run lineage verification**

```bash
rtk pnpm test:infra:up
rtk pnpm --filter @shape-and-flow/booking-api prisma:migrate:deploy
rtk pnpm --filter @shape-and-flow/booking-api exec vitest run --config vitest.integration.config.ts test/integration/reschedule.int.spec.ts test/integration/booking-financials.int.spec.ts
rtk pnpm --filter @shape-and-flow/booking-api typecheck
```

- [ ] **Step 7: Commit Task 4**

```bash
rtk git add -- booking-app/apps/api/prisma/schema.prisma booking-app/apps/api/prisma/migrations/20260802120000_financial_booking_root/migration.sql booking-app/apps/api/src/payment/booking-financials.service.ts booking-app/apps/api/src/payment/payment.module.ts booking-app/apps/api/src/booking/reschedule.service.ts booking-app/apps/api/test/integration/booking-financials.int.spec.ts booking-app/apps/api/test/integration/reschedule.int.spec.ts
rtk git diff --cached --check
rtk git commit -m "feat(payments): add booking financial root"
```

### Task 5: Move every financial consumer to the shared root

**Files:**

- Modify: `booking-app/apps/api/src/manage/manage.controller.ts:35-190`
- Modify: `booking-app/apps/api/src/manage/manage.module.ts:1-24`
- Modify: `booking-app/apps/api/src/office/office-bookings.service.ts:25-300`
- Modify: `booking-app/apps/api/src/office/customers.service.ts`
- Modify: `booking-app/apps/api/src/office/requests.service.ts:1-175`
- Modify: `booking-app/apps/api/src/office/exports.service.ts`
- Modify: `booking-app/apps/api/src/notification/booking-notification-data.service.ts:12-90`
- Modify: `booking-app/apps/api/src/notification/notification.module.ts`
- Modify: `booking-app/apps/api/src/payment/manual-payment.service.ts:45-135`
- Test: `booking-app/apps/api/test/integration/office-bookings.int.spec.ts`
- Test: `booking-app/apps/api/test/integration/manage-auth.int.spec.ts`
- Test: `booking-app/apps/api/test/integration/reschedule.int.spec.ts`

**Interfaces:**

- Consumes: Task 4 `BookingFinancialsService.load()` and `loadMany()`.
- Produces: no direct booking relation read for `payments`, `manualPayments`, or aggregate refunds in a reschedule-aware response.
- Produces: manual payments attached to `financialRootBookingId ?? booking.id`.

- [ ] **Step 1: Add failing public and office financial-visibility tests**

After two approved reschedules, call the current management token and office detail routes:

```ts
expect((manage.body as ManageBookingResponse).paid.amountCents).toBe(
  ctx.service30.priceCents,
);
expect((detail.body as OfficeBookingDetail).payments).toHaveLength(1);
expect((detail.body as OfficeBookingDetail).payments[0]?.status).toBe(
  "SUCCEEDED",
);
```

Record a manual payment against the first replacement, create the second replacement, and assert the second office detail and export totals include it once.

- [ ] **Step 2: Run the focused consumers and verify zero/empty financials**

```bash
rtk pnpm --filter @shape-and-flow/booking-api exec vitest run --config vitest.integration.config.ts test/integration/office-bookings.int.spec.ts test/integration/manage-auth.int.spec.ts test/integration/reschedule.int.spec.ts
```

Expected: replacement views report zero paid or empty payments/refunds.

- [ ] **Step 3: Replace list/detail financial relation reads in batches**

For office lists and exports:

```ts
const financials = await this.financials.loadMany(rows.map((row) => row.id));
return rows.map((row) =>
  toDto(row, financials.get(row.id) ?? emptyFinancials(row.id)),
);
```

Remove financial relation fields from `LIST_FIELDS`, `DETAIL_FIELDS`, and `REQUEST_BOOKING`. Keep non-financial booking relations unchanged.

- [ ] **Step 4: Replace single-booking consumers**

In manage, customer, request reachability, and notification data loaders, load booking identity first and then use the same explicit sequence:

```ts
const booking = await this.prisma.booking.findFirst({
  where: { id: bookingId, organizationId },
  select: BOOKING_IDENTITY,
});
if (booking === null)
  throw new AppError("NOT_FOUND", { message: "Booking not found." });

const financials = await this.financials.load(booking.id);
const paid = receivedFrom(financials.payments, financials.manualPayments);
const refunded = refundedTotal(financials.refunds);
return toDto(booking, { ...financials, paid, refunded });
```

Use this in `ManageController`, `CustomersService`, `RequestsService`, and `BookingNotificationDataService`; do not retain a fallback read from `booking.payments` or `booking.manualPayments`.

- [ ] **Step 5: Attach new manual payments to the root**

In `ManualPaymentService.record()` resolve the root before the transaction and persist:

```ts
const rootBookingId = await this.financials.rootBookingId(booking.id);
// manualPayment.create data
bookingId: rootBookingId,
```

Keep the audit `after.bookingId` equal to the booking on which the office acted, and include `financialRootBookingId: rootBookingId` as additional audit detail.

- [ ] **Step 6: Wire `PaymentModule` into consumers**

Export the service and add `PaymentModule` to each consumer without forming a cycle:

```ts
// payment.module.ts
providers: [BookingFinancialsService, RefundService, RefundProcessor, RefundWebhookHandler, ManualPaymentService],
exports: [BookingFinancialsService, RefundService, RefundProcessor, RefundWebhookHandler, ManualPaymentService],

// manage.module.ts
imports: [PublicModule, BookingModule, PaymentModule],

// notification.module.ts
imports: [PaymentModule],
```

Inject it as `private readonly financials: BookingFinancialsService` in each listed consumer. `OfficeModule` already imports `PaymentModule`; do not import `BookingModule` into `PaymentModule`.

- [ ] **Step 7: Run consumer tests and query-count-sensitive checks**

```bash
rtk pnpm --filter @shape-and-flow/booking-api exec vitest run --config vitest.integration.config.ts test/integration/office-bookings.int.spec.ts test/integration/manage-auth.int.spec.ts test/integration/reschedule.int.spec.ts test/integration/notifications.int.spec.ts
rtk pnpm --filter @shape-and-flow/booking-api typecheck
rtk pnpm --filter @shape-and-flow/booking-api lint
```

- [ ] **Step 8: Commit Task 5**

```bash
rtk git add -p -- booking-app/apps/api/src/manage booking-app/apps/api/src/office/office-bookings.service.ts booking-app/apps/api/src/office/customers.service.ts booking-app/apps/api/src/office/requests.service.ts booking-app/apps/api/src/office/exports.service.ts booking-app/apps/api/src/notification booking-app/apps/api/src/payment/manual-payment.service.ts booking-app/apps/api/test/integration/office-bookings.int.spec.ts booking-app/apps/api/test/integration/manage-auth.int.spec.ts booking-app/apps/api/test/integration/reschedule.int.spec.ts
rtk git diff --cached --check
rtk git commit -m "fix(payments): read reschedule financial root"
```

### Task 6: Centralize pending-refund reservation and capability checks

**Files:**

- Modify: `booking-app/apps/api/src/payment/refund.service.ts:20-410`
- Modify: `booking-app/apps/api/src/booking/cancellation.service.ts:35-625`
- Modify: `booking-app/apps/api/src/office/requests.controller.ts:55-90`
- Modify: `booking-app/apps/api/src/office/requests.service.ts:100-150`
- Test: `booking-app/apps/api/test/integration/refund.int.spec.ts`
- Test: `booking-app/apps/api/test/integration/cancellation.int.spec.ts`
- Test: `booking-app/apps/api/test/integration/office-bookings.int.spec.ts`

**Interfaces:**

- Consumes: Task 4 `BookingFinancialsService.rootBookingId()`.
- Produces: `RefundService.reserveInTransaction(tx, input): Promise<RefundReservationResult>`.
- Produces: `DecideRequestInput.mayIssueRefunds: boolean` enforced inside the decision transaction.

- [ ] **Step 1: Add failing pending-balance and cancellation-delta tests**

Add to `refund.int.spec.ts`:

```ts
it("subtracts pending refunds from the remaining balance", async () => {
  await service.request({ bookingId, amountCents: 4000, reason: "GOODWILL" });
  await expect(
    service.request({ bookingId, amountCents: 1000, reason: "GOODWILL" }),
  ).rejects.toMatchObject({ code: "PAYMENT_NOT_REFUNDABLE" });
});

it("serializes concurrent refund reservations", async () => {
  const results = await Promise.allSettled([
    service.request({ bookingId, amountCents: 3000, reason: "GOODWILL" }),
    service.request({ bookingId, amountCents: 3000, reason: "GOODWILL" }),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(
    (
      await prisma.refund.aggregate({
        where: { paymentId },
        _sum: { amountCents: true },
      })
    )._sum.amountCents,
  ).toBe(3000);
});
```

Add cancellation cases with a successful partial refund and with a pending partial refund; each must create only `gross - retained - successful - pending`.

- [ ] **Step 2: Add failing effective-retention authorization tests**

Through the office HTTP route, use an admin with `canIssueRefunds: false`:

```ts
await decide(requestId, { decision: "APPROVED" }, adminWithoutRefunds).expect(
  200,
);
expect(await prisma.refund.count({ where: { bookingId } })).toBe(0);
```

Seed `suggestedRetainedAmountCents` equal to paid for the allowed case and lower than paid for the forbidden case. The lower suggestion must return 403 even when the body omits `retainedAmountCents`.

- [ ] **Step 3: Run refund/cancellation suites and confirm over-reservation**

```bash
rtk pnpm --filter @shape-and-flow/booking-api exec vitest run --config vitest.integration.config.ts test/integration/refund.int.spec.ts test/integration/cancellation.int.spec.ts test/integration/office-bookings.int.spec.ts
```

Expected: a second pending refund is accepted, cancellation requests the gross target again, and the full-retention omitted body is incorrectly forbidden.

- [ ] **Step 4: Implement the discriminated reservation input**

Use these types:

```ts
type RefundAmount =
  | { kind: "ADDITIONAL"; amountCents: number }
  | { kind: "CUMULATIVE_TARGET"; targetAmountCents: number };

interface RefundReservationResult {
  refundId: string | null;
  additionalAmountCents: number;
  refundableAmountCents: number;
}
```

`reserveInTransaction()` resolves the root, locks the settled provider payment, sums `PENDING` refunds, and computes:

```ts
const reservedCents =
  payment.refundedAmountCents + (pending._sum.amountCents ?? 0);
const refundable = Money.fromCents(payment.amountCents, payment.currency).minus(
  Money.fromCents(reservedCents, payment.currency),
);
const additionalCents =
  input.amount.kind === "ADDITIONAL"
    ? input.amount.amountCents
    : Math.max(0, input.amount.targetAmountCents - reservedCents);
```

Validate explicit additional amounts against `refundable`. For a cumulative target already satisfied, return `refundId: null` without an outbox row.

- [ ] **Step 5: Route standalone and cancellation refunds through the same method**

`RefundService.request()` opens a transaction and calls `reserveInTransaction()` with `ADDITIONAL`. Delete `CancellationService.requestRefund()`. Immediate and approved customer cancellation pass `CUMULATIVE_TARGET` equal to `paid.minus(retained).amountCents`; business cancellation passes `ADDITIONAL` because the entered amount means “refund this much now.”

- [ ] **Step 6: Enforce capability on the actual additional amount**

Pass `mayIssueRefunds: session.canIssueRefunds` from `RequestsController`. After `reserveInTransaction()` computes the amount and before the transaction commits:

```ts
if (refund.additionalAmountCents > 0 && !input.mayIssueRefunds) {
  throw new AppError("FORBIDDEN", {
    status: 403,
    message: "Refund capability required.",
  });
}
```

Apply `input.retainedAmountCents ?? request.suggestedRetainedAmountCents` before calculating the target. Remove the controller's `?? 0` check; any retained preview must use the request suggestion returned by `RequestsService`.

- [ ] **Step 7: Run financial mutation verification**

```bash
rtk pnpm --filter @shape-and-flow/booking-api exec vitest run --config vitest.integration.config.ts test/integration/refund.int.spec.ts test/integration/cancellation.int.spec.ts test/integration/reschedule.int.spec.ts test/integration/office-bookings.int.spec.ts
rtk pnpm --filter @shape-and-flow/booking-api typecheck
rtk pnpm --filter @shape-and-flow/booking-api lint
```

- [ ] **Step 8: Commit Task 6**

```bash
rtk git add -p -- booking-app/apps/api/src/payment/refund.service.ts booking-app/apps/api/src/booking/cancellation.service.ts booking-app/apps/api/src/office/requests.controller.ts booking-app/apps/api/src/office/requests.service.ts booking-app/apps/api/test/integration/refund.int.spec.ts booking-app/apps/api/test/integration/cancellation.int.spec.ts booking-app/apps/api/test/integration/office-bookings.int.spec.ts
rtk git diff --cached --check
rtk git commit -m "fix(refunds): reserve remaining balance once"
```

### Task 7: Make login lockout updates atomic

**Files:**

- Modify: `booking-app/apps/api/src/auth/auth.controller.ts:95-280`
- Test: `booking-app/apps/api/test/integration/auth.int.spec.ts`

**Interfaces:**

- Produces: `recordFailure(officeUserId: string): Promise<void>` with no stale counter argument.
- Produces: conditional successful-login reset that returns whether login remained eligible.

- [ ] **Step 1: Add a failing parallel failure test**

```ts
it("counts parallel failures without losing increments", async () => {
  await prisma.officeUser.updateMany({
    where: { email: OWNER_EMAIL },
    data: { failedLoginAttempts: MAX_FAILED_ATTEMPTS - 2 },
  });

  const responses = await Promise.all([
    login({ email: OWNER_EMAIL, password: "wrong-but-long" }),
    login({ email: OWNER_EMAIL, password: "wrong-but-long" }),
  ]);
  expect(responses.map((response) => response.status)).toEqual([401, 401]);
  const user = await prisma.officeUser.findFirstOrThrow({
    where: { email: OWNER_EMAIL },
  });
  expect(user.failedLoginAttempts).toBe(MAX_FAILED_ATTEMPTS);
  expect(user.lockedUntil).not.toBeNull();
});
```

- [ ] **Step 2: Run the auth suite and observe the lost update**

```bash
rtk pnpm --filter @shape-and-flow/booking-api exec vitest run --config vitest.integration.config.ts test/integration/auth.int.spec.ts
```

Expected: the stored counter can remain one below the threshold.

- [ ] **Step 3: Increment and establish lockout in one transaction**

Replace the stale-value method with:

```ts
private async recordFailure(officeUserId: string): Promise<void> {
  await this.prisma.$transaction(async (tx) => {
    const user = await tx.officeUser.update({
      where: { id: officeUserId },
      data: { failedLoginAttempts: { increment: 1 } },
      select: { failedLoginAttempts: true },
    });
    if (user.failedLoginAttempts >= MAX_FAILED_ATTEMPTS) {
      await tx.officeUser.update({
        where: { id: officeUserId },
        data: { lockedUntil: new Date(this.clock.now().getTime() + LOCKOUT_MINUTES * 60_000) },
        select: { id: true },
      });
    }
  });
}
```

Call it with only `user.id`.

- [ ] **Step 4: Condition the successful reset**

Use one conditional write after password verification:

```ts
const now = this.clock.now();
const reset = await this.prisma.officeUser.updateMany({
  where: {
    id: user.id,
    archivedAt: null,
    OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
  },
  data: { failedLoginAttempts: 0, lockedUntil: null },
});
if (reset.count !== 1) {
  throw new AppError("INVALID_CREDENTIALS", {
    status: 401,
    message: "Invalid email or password.",
  });
}
const session = await this.sessions.create(user.id);
```

Keep session creation after this check. Reuse the controller's existing generic invalid-credentials helper if it exists rather than introducing a second error message.

- [ ] **Step 5: Run auth verification**

```bash
rtk pnpm --filter @shape-and-flow/booking-api exec vitest run --config vitest.integration.config.ts test/integration/auth.int.spec.ts
rtk pnpm --filter @shape-and-flow/booking-api typecheck
rtk pnpm --filter @shape-and-flow/booking-api lint
```

- [ ] **Step 6: Commit Task 7**

```bash
rtk git add -- booking-app/apps/api/src/auth/auth.controller.ts booking-app/apps/api/test/integration/auth.int.spec.ts
rtk git diff --cached --check
rtk git commit -m "fix(auth): serialize login lockout updates"
```

### Task 8: Refresh worker settings before each job

**Files:**

- Modify: `booking-app/apps/api/src/messaging/queues/worker-registrar.service.ts:55-230`
- Test: `booking-app/apps/api/test/integration/worker-bootstrap.int.spec.ts`

**Interfaces:**

- Consumes: `OrganizationContextService.refresh(): Promise<void>`.
- Produces: `runWithJobScope()` that refreshes the worker-local organization cache before invoking the job callback.

- [ ] **Step 1: Add a failing independent-cache test**

```ts
it("refreshes settings before the next job scope", async () => {
  await prisma.organizationSettings.updateMany({
    data: { smsRemindersEnabled: false },
  });
  const organizations = context.get(OrganizationContextService);

  const enabled = await registrar.runWithJobScope({}, () =>
    Promise.resolve(organizations.getSettings().smsRemindersEnabled),
  );

  expect(enabled).toBe(false);
});
```

Import `OrganizationContextService` into the test.

- [ ] **Step 2: Run the worker suite and verify it reads the boot value**

```bash
rtk pnpm --filter @shape-and-flow/booking-api exec vitest run --config vitest.integration.config.ts test/integration/worker-bootstrap.int.spec.ts
```

Expected: the callback sees the setting cached during `beforeAll`.

- [ ] **Step 3: Refresh inside the job correlation scope**

Inject `OrganizationContextService` into `WorkerRegistrarService` and update:

```ts
async runWithJobScope<T>(payload: { correlationId?: string }, fn: () => Promise<T>): Promise<T> {
  return await runWithCorrelation(payload.correlationId ?? newCorrelationId(), async () => {
    await this.organizations.refresh();
    return await fn();
  });
}
```

Do not add a BullMQ refresh job or Redis subscriber.

- [ ] **Step 4: Run worker, type, and lint verification**

```bash
rtk pnpm --filter @shape-and-flow/booking-api exec vitest run --config vitest.integration.config.ts test/integration/worker-bootstrap.int.spec.ts
rtk pnpm --filter @shape-and-flow/booking-api typecheck
rtk pnpm --filter @shape-and-flow/booking-api lint
```

- [ ] **Step 5: Commit Task 8**

```bash
rtk git add -- booking-app/apps/api/src/messaging/queues/worker-registrar.service.ts booking-app/apps/api/test/integration/worker-bootstrap.int.spec.ts
rtk git diff --cached --check
rtk git commit -m "fix(worker): refresh settings before jobs"
```

### Task 9: Preserve public web draft lifecycle state

**Files:**

- Modify: `booking-app/apps/web/src/stores/booking-draft.ts:15-290`
- Modify: `booking-app/apps/web/src/pages/public/RedirectToCheckout.vue:1-70`
- Modify: `booking-app/apps/web/src/pages/public/BookingSuccess.vue:1-125`
- Test: `booking-app/apps/web/src/stores/booking-draft.spec.ts`
- Test: `booking-app/apps/web/src/pages/public/RedirectToCheckout.spec.ts`
- Test: `booking-app/apps/web/src/pages/public/BookingSuccess.spec.ts`

**Interfaces:**

- Produces: persisted `employeeChosen: boolean`.
- Produces: `expireReservation(): void`, which clears slot/reservation, rotates the key, and preserves earlier choices/details.
- Produces: component-local `confirmationEmail` captured before reset.

- [ ] **Step 1: Add a failing explicit-any reload test**

```ts
it("persists an explicit any-employee choice across reload", () => {
  const first = useBookingDraft();
  first.setService("s1");
  first.setEmployee(null);
  setActivePinia(createPinia());

  const reloaded = useBookingDraft();
  expect(reloaded.employeeId).toBeNull();
  expect(reloaded.employeeChosen).toBe(true);
  expect(reloaded.canReach("slot")).toBe(true);
});
```

- [ ] **Step 2: Add failing expiry-key and success-email tests**

For the store:

```ts
const oldKey = store.idempotencyKey;
store.expireReservation();
expect(store.idempotencyKey).not.toBe(oldKey);
expect(store.slot).toBeNull();
expect(store.reservation).toBeNull();
expect(store.firstName).toBe("Anna");
expect(store.serviceId).toBe("s1");
```

For `BookingSuccess.spec.ts`, seed `useBookingDraft().email = 'anna@example.com'`, return `CONFIRMED`, and assert the rendered copy contains that email while the store email and session storage are empty.

- [ ] **Step 3: Run web tests and verify all three failures**

```bash
rtk pnpm --filter @shape-and-flow/booking-web exec vitest run src/stores/booking-draft.spec.ts src/pages/public/RedirectToCheckout.spec.ts src/pages/public/BookingSuccess.spec.ts
```

- [ ] **Step 4: Persist `employeeChosen` with backward compatibility**

Add the field to `PersistedDraft` and `emptyDraft`, initialize it with:

```ts
const employeeChosen = ref(
  stored.employeeChosen === true ||
    (stored.employeeChosen === undefined && stored.employeeId !== null),
);
```

Persist and watch it. Old stored objects with a non-null employee remain chosen; an old null remains safely unchosen.

- [ ] **Step 5: Add the expired-reservation transition and local email snapshot**

Implement:

```ts
function expireReservation(): void {
  slotStartsAt.value = null;
  reservation.value = null;
  idempotencyKey.value = crypto.randomUUID();
  persist();
}
```

Call it from `RedirectToCheckout.onExpired()`. In `BookingSuccess.vue`, define `const confirmationEmail = ref(draft.email)` before `onMounted` and render it instead of `draft.email`; keep the immediate `draft.reset()`.

- [ ] **Step 6: Run web tests, typecheck, and lint**

```bash
rtk pnpm --filter @shape-and-flow/booking-web exec vitest run src/stores/booking-draft.spec.ts src/pages/public/RedirectToCheckout.spec.ts src/pages/public/BookingSuccess.spec.ts
rtk pnpm --filter @shape-and-flow/booking-web typecheck
rtk pnpm --filter @shape-and-flow/booking-web lint
```

- [ ] **Step 7: Commit Task 9**

```bash
rtk git add -- booking-app/apps/web/src/stores/booking-draft.ts booking-app/apps/web/src/stores/booking-draft.spec.ts booking-app/apps/web/src/pages/public/RedirectToCheckout.vue booking-app/apps/web/src/pages/public/RedirectToCheckout.spec.ts booking-app/apps/web/src/pages/public/BookingSuccess.vue booking-app/apps/web/src/pages/public/BookingSuccess.spec.ts
rtk git diff --cached --check
rtk git commit -m "fix(web): preserve booking attempt state"
```

### Task 10: Deduplicate audits and select the correct entity ID

**Files:**

- Modify: `booking-app/apps/api/src/common/audit/audit.interceptor.ts:15-180`
- Modify: `booking-app/apps/api/src/office/office-bookings.controller.ts:75-190`
- Modify: `booking-app/apps/api/src/office/requests.controller.ts:55-120`
- Modify: `booking-app/apps/api/test/integration/office-authorization.int.spec.ts`
- Test: `booking-app/apps/api/test/integration/office-bookings.int.spec.ts`
- Test: `booking-app/apps/api/test/integration/cancellation.int.spec.ts`
- Test: `booking-app/apps/api/test/integration/reschedule.int.spec.ts`

**Interfaces:**

- Produces: `AuditSpec.responseIdField?: string`.
- Produces: service-audited route allowlist entries for five handlers.

- [ ] **Step 1: Add failing exact-count and ID tests**

Exercise the real HTTP routes for business cancel, complete, no-show, cancellation decision, and reschedule decision, then assert:

```ts
expect(
  await prisma.auditLog.count({
    where: { action: "BOOKING_CANCELED", entityId: bookingId },
  }),
).toBe(1);
```

Repeat with each matching action. For manual booking and refund creation:

```ts
expect(
  await prisma.auditLog.findFirstOrThrow({
    where: { action: "BOOKING_CREATED_MANUALLY" },
  }),
).toMatchObject({ entityId: created.body.bookingId });
expect(
  await prisma.auditLog.findFirstOrThrow({
    where: { action: "REFUND_ISSUED" },
  }),
).toMatchObject({ entityId: refunded.body.refundId });
```

- [ ] **Step 2: Run office mutation suites and observe duplicates/wrong IDs**

```bash
rtk pnpm --filter @shape-and-flow/booking-api exec vitest run --config vitest.integration.config.ts test/integration/office-bookings.int.spec.ts test/integration/cancellation.int.spec.ts test/integration/reschedule.int.spec.ts test/integration/office-authorization.int.spec.ts
```

- [ ] **Step 3: Remove the five duplicate decorators**

Remove `@Audited` only from `OfficeBookingsController.cancel`, `complete`, and `noShow`, plus `RequestsController.decideCancellation` and `decideReschedule`. Keep transactional service calls unchanged. Expand the exact allowlist while preserving the user's existing authorization matrix edits:

```ts
const auditedInService = new Set([
  "CustomersController.update",
  "CustomersController.erase",
  "OfficeBookingsController.recordManualPayment",
  "OfficeBookingsController.cancel",
  "OfficeBookingsController.complete",
  "OfficeBookingsController.noShow",
  "RequestsController.decideCancellation",
  "RequestsController.decideReschedule",
]);
```

- [ ] **Step 4: Add declarative response ID extraction**

Extend the spec:

```ts
export interface AuditSpec {
  action: AuditAction;
  entityType: string;
  responseIdField?: string;
}
```

Resolve the ID with:

```ts
const entityId =
  detail.entityId ??
  idFrom(body, spec.responseIdField) ??
  (typeof fromPath === "string" ? fromPath : "-");
```

Implement and use the helper:

```ts
function idFrom(body: unknown, field?: string): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  const candidate = field === undefined ? record.id : record[field];
  if (typeof candidate === "string") return candidate;
  return typeof record.id === "string" ? record.id : undefined;
}
```

Keep manual creation and refund creation interceptor-owned, with these exact decorators:

```ts
@Audited({
  action: 'BOOKING_CREATED_MANUALLY',
  entityType: 'Booking',
  responseIdField: 'bookingId',
})

@Audited({
  action: 'REFUND_ISSUED',
  entityType: 'Refund',
  responseIdField: 'refundId',
})
```

- [ ] **Step 5: Run audit and authorization verification**

```bash
rtk pnpm --filter @shape-and-flow/booking-api exec vitest run --config vitest.integration.config.ts test/integration/office-bookings.int.spec.ts test/integration/cancellation.int.spec.ts test/integration/reschedule.int.spec.ts test/integration/office-authorization.int.spec.ts
rtk pnpm --filter @shape-and-flow/booking-api typecheck
rtk pnpm --filter @shape-and-flow/booking-api lint
```

- [ ] **Step 6: Commit only Task 10 hunks**

```bash
rtk git add -p -- booking-app/apps/api/src/common/audit/audit.interceptor.ts booking-app/apps/api/src/office/office-bookings.controller.ts booking-app/apps/api/src/office/requests.controller.ts booking-app/apps/api/test/integration/office-authorization.int.spec.ts booking-app/apps/api/test/integration/office-bookings.int.spec.ts booking-app/apps/api/test/integration/cancellation.int.spec.ts booking-app/apps/api/test/integration/reschedule.int.spec.ts
rtk git diff --cached --check
rtk git commit -m "fix(audit): write one row with correct id"
```

### Task 11: End-to-end journeys and whole-branch verification

**Files:**

- Create: `booking-app/apps/web/e2e/review-remediation.spec.ts`
- Modify: `booking-app/apps/web/e2e/fixtures/stack.ts` only if the existing test-support client lacks the required provider-failure and request-decision calls
- Review: every file changed by Tasks 1–10

**Interfaces:**

- Consumes: all prior task interfaces.
- Produces: browser-level proof for Checkout retry/expiry and reschedule/refund continuity.

- [ ] **Step 1: Add the public Checkout retry and expiry journey**

Use the existing stack fixture to select a service, choose “any employee,” enter customer details, force one Checkout failure, resubmit with the persisted key, and assert the Checkout interstitial appears for the same booking reference. Then expire a reservation, select a new slot, and assert the next request does not return `IDEMPOTENCY_KEY_REUSED`.

The key assertions in `review-remediation.spec.ts` are:

```ts
await expect(page.getByTestId("reference")).toHaveText(firstReference);
await expect(page.getByTestId("reservation-expired")).toBeVisible();
await expect(page.getByTestId("error")).not.toContainText("Idempotency");
```

- [ ] **Step 2: Add the repeated-reschedule refund journey**

Create and pay a booking through test support, approve two reschedules through the office API/UI, open the latest booking detail, and assert the paid amount remains present. Issue a partial refund from the latest booking and assert one provider refund call against the original charge.

```ts
await expect(page.getByTestId("paid-total")).toContainText("45,00");
await expect(page.getByTestId("refund-status")).toContainText(
  /pending|ausstehend/i,
);
```

- [ ] **Step 3: Run focused unit and integration suites together**

```bash
rtk pnpm --filter @shape-and-flow/booking-api test
rtk pnpm --filter @shape-and-flow/booking-web test
rtk pnpm --filter @shape-and-flow/booking-notification-templates test
rtk pnpm --filter @shape-and-flow/booking-api test:integration
```

Expected: all commands exit 0 with no failed tests.

- [ ] **Step 4: Run repository quality gates**

```bash
rtk pnpm lint
rtk pnpm format
rtk pnpm typecheck
rtk pnpm build
```

Expected: all commands exit 0.

- [ ] **Step 5: Run browser journeys**

```bash
rtk pnpm test:e2e -- booking-app/apps/web/e2e/review-remediation.spec.ts
```

Expected: both remediation journeys pass against the isolated test stack.

- [ ] **Step 6: Verify the 16-finding checklist and migration state**

Read the traceability table in `docs/superpowers/specs/2026-08-02-booking-review-remediation-design.md` and identify the exact passing test for each row. Then run:

```bash
rtk pnpm --filter @shape-and-flow/booking-api prisma:migrate:deploy
rtk git diff --check
rtk git status --short
```

Expected: migration reports no pending failure, diff check is clean, and status contains no accidental generated, environment, or unrelated staged files.

- [ ] **Step 7: Commit the end-to-end test and any fixture-only support**

```bash
rtk git add -p -- booking-app/apps/web/e2e/review-remediation.spec.ts booking-app/apps/web/e2e/fixtures/stack.ts
rtk git diff --cached --check
rtk git commit -m "test(e2e): cover booking remediation flows"
```

- [ ] **Step 8: Request final whole-branch review**

Create the review package from the merge base through `HEAD`, give the reviewer this plan, the approved design spec, and the task ledger, and fix every Critical or Important finding before branch completion. The final reviewer must specifically check the 16-row traceability table, financial-root consumers, provider-call transaction boundaries, and preservation of pre-existing user changes.
