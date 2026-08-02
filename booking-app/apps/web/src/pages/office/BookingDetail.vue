<script setup lang="ts">
import {
  SfAlert,
  SfButton,
  SfCard,
  SfInput,
  SfModal,
  SfSelect,
  SfSkeleton,
} from '@shape-and-flow/booking-ui';
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';

import { api } from '../../api/client.js';
import StatusBadge from '../../components/office/StatusBadge.vue';
import { useAsyncData } from '../../composables/useAsyncData.js';
import { useFocusStep } from '../../composables/useFocusStep.js';
import { dateTime, difference, hasPassed, money, time } from '../../office/format.js';
import { officeMessage } from '../../office/messages.js';
import { useOfficeAction } from '../../office/useOfficeAction.js';
import { useSession } from '../../stores/session.js';

/**
 * One booking, and every action that can be taken on it.
 *
 * Two rules run through the whole screen.
 *
 * **Every action is gated by `can(...)` and confirmed before it happens**, and the
 * confirmation restates the consequence in the operator's own numbers — the refund
 * amount, the reason that will be recorded. "Are you sure?" is not a confirmation; it is
 * a second click.
 *
 * **Nothing is optimistic.** Each action disables, calls, and refetches. A `409` here is
 * ordinary — somebody else decided the request first — and a rolled-back optimistic
 * update is more confusing than a spinner.
 */
const route = useRoute();
const session = useSession();

useFocusStep('Booking');

const id = computed(() => String(route.params.id));

const { data, errorKey, loading, run } = useAsyncData((signal) =>
  api.office.bookings.detail(id.value, signal),
);

const action = useOfficeAction(run);

/** Which confirmation is open. `null` means none. */
const dialog = ref<'complete' | 'no-show' | 'cancel' | 'payment' | 'refund' | null>(null);

const PAYMENT_METHODS = [
  { value: 'CASH', label: 'Cash' },
  { value: 'CARD', label: 'Card terminal' },
  { value: 'BANK_TRANSFER', label: 'Bank transfer' },
  { value: 'OTHER', label: 'Other' },
];

/**
 * The three an office actually picks from.
 *
 * `CUSTOMER_CANCELLATION` is deliberately absent: that reason belongs to the
 * cancellation flow, which records it automatically, and offering it here would let
 * somebody file a goodwill refund under a decision the customer never made.
 */
const REFUND_REASONS = [
  { value: 'GOODWILL', label: 'Goodwill' },
  { value: 'BUSINESS_CANCELLATION', label: 'We cancelled' },
  { value: 'DUPLICATE_PAYMENT', label: 'Paid twice' },
];

const cancelReason = ref('');
const cancelRefundEuros = ref('');
const paymentEuros = ref('');
const paymentMethod = ref<'CASH' | 'CARD' | 'BANK_TRANSFER' | 'OTHER'>('CASH');
const paymentNote = ref('');
const refundEuros = ref('');
const refundReason = ref<'GOODWILL' | 'BUSINESS_CANCELLATION' | 'DUPLICATE_PAYMENT'>('GOODWILL');

/** Euros as typed, to integer cents. Returns `null` for anything unparseable. */
function toCents(value: string): number | null {
  const normalised = value.trim().replace(',', '.');
  if (!/^-?\d+(\.\d{1,2})?$/.test(normalised)) return null;

  // Rounded rather than truncated: `4.005` is a typo either way, and rounding is the
  // direction that does not silently lose a cent.
  return Math.round(Number(normalised) * 100);
}

const outstanding = computed(() =>
  data.value === null ? 0 : difference(data.value.price, data.value.paid).amountCents,
);

const cancelRefundCents = computed(() => toCents(cancelRefundEuros.value));
const paymentCents = computed(() => toCents(paymentEuros.value));
const refundCents = computed(() => toCents(refundEuros.value));

/** A negative correction needs a note — the same rule the API enforces, said earlier. */
const paymentValid = computed(
  () =>
    paymentCents.value !== null &&
    paymentCents.value !== 0 &&
    (paymentCents.value > 0 || paymentNote.value.trim() !== ''),
);

const refundValid = computed(
  () =>
    refundCents.value !== null &&
    refundCents.value > 0 &&
    data.value !== null &&
    refundCents.value <= data.value.paid.amountCents,
);

const cancelValid = computed(
  () =>
    cancelReason.value.trim() !== '' &&
    (cancelRefundEuros.value.trim() === '' ||
      (cancelRefundCents.value !== null && cancelRefundCents.value >= 0)),
);

/**
 * A fresh idempotency key per attempt, minted when the dialog is confirmed.
 *
 * Per attempt rather than per dialog: if the first try failed with a network error the
 * operator is deciding again, and reusing the key would replay whatever the server did
 * with it — including a refusal.
 */
function newKey(): string {
  return crypto.randomUUID();
}

function close(): void {
  dialog.value = null;
  action.clearError();
}

async function confirmComplete(): Promise<void> {
  if (await action.run(() => api.office.bookings.complete(id.value))) close();
}

async function confirmNoShow(): Promise<void> {
  if (await action.run(() => api.office.bookings.noShow(id.value))) close();
}

async function confirmCancel(): Promise<void> {
  const refund = cancelRefundCents.value;

  const done = await action.run(() =>
    api.office.bookings.cancel(id.value, {
      reason: cancelReason.value.trim(),
      ...(cancelRefundEuros.value.trim() === '' || refund === null
        ? {}
        : { refund: { amountCents: refund } }),
    }),
  );

  if (done) {
    cancelReason.value = '';
    cancelRefundEuros.value = '';
    close();
  }
}

async function confirmPayment(): Promise<void> {
  const cents = paymentCents.value;
  if (cents === null) return;

  const done = await action.run(() =>
    api.office.bookings.recordPayment(
      id.value,
      {
        amountCents: cents,
        method: paymentMethod.value,
        ...(paymentNote.value.trim() === '' ? {} : { note: paymentNote.value.trim() }),
      },
      newKey(),
    ),
  );

  if (done) {
    paymentEuros.value = '';
    paymentNote.value = '';
    close();
  }
}

async function confirmRefund(): Promise<void> {
  const cents = refundCents.value;
  if (cents === null) return;

  const done = await action.run(() =>
    api.office.bookings.refund(
      id.value,
      { amountCents: cents, reason: refundReason.value },
      newKey(),
    ),
  );

  if (done) {
    refundEuros.value = '';
    close();
  }
}

/** Completion and no-show only make sense once the appointment has been and gone. */
const isPast = computed(() => data.value !== null && hasPassed(data.value.endsAt));

const isLive = computed(() => data.value?.status === 'CONFIRMED');

onMounted(run);
</script>

<template>
  <section class="space-y-4">
    <SfAlert v-if="errorKey !== null" tone="danger" data-test="error">
      {{ officeMessage(errorKey) }}
    </SfAlert>

    <SfSkeleton v-if="loading && data === null" class="h-96" />

    <template v-else-if="data !== null">
      <header class="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 ref="heading" tabindex="-1" class="text-xl font-semibold tracking-tight outline-none">
            {{ data.reference }}
          </h1>
          <p class="text-text-secondary">
            {{ dateTime(data.startsAt) }}–{{ time(data.endsAt) }} · {{ data.employeeName }}
          </p>
        </div>
        <StatusBadge :status="data.displayStatus" />
      </header>

      <SfAlert v-if="action.error.value !== null" tone="danger" data-test="action-error">
        {{ action.error.value }}
      </SfAlert>

      <!-- Action bar. Every button is behind a capability; none of them acts on click. -->
      <div class="flex flex-wrap gap-2" data-test="actions">
        <SfButton
          v-if="session.can('booking.complete') && isLive && isPast"
          variant="secondary"
          data-test="action-complete"
          @click="dialog = 'complete'"
        >
          Mark completed
        </SfButton>

        <SfButton
          v-if="session.can('booking.complete') && isLive && isPast"
          variant="secondary"
          data-test="action-no-show"
          @click="dialog = 'no-show'"
        >
          Mark no show
        </SfButton>

        <SfButton
          v-if="session.can('payment.recordManual')"
          variant="secondary"
          data-test="action-payment"
          @click="dialog = 'payment'"
        >
          Record payment
        </SfButton>

        <SfButton
          v-if="session.can('refund.issue') && data.paid.amountCents > 0"
          variant="secondary"
          data-test="action-refund"
          @click="dialog = 'refund'"
        >
          Refund
        </SfButton>

        <SfButton
          v-if="session.can('booking.cancel') && isLive"
          variant="danger"
          data-test="action-cancel"
          @click="dialog = 'cancel'"
        >
          Cancel booking
        </SfButton>
      </div>

      <div class="grid gap-4 lg:grid-cols-2">
        <SfCard as="section" aria-labelledby="summary-heading">
          <h2 id="summary-heading" class="text-lg font-medium">Appointment</h2>
          <dl class="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt class="text-text-secondary">Treatment</dt>
            <dd>{{ data.serviceName }} ({{ data.durationMinutes }} min)</dd>
            <dt class="text-text-secondary">Blocked</dt>
            <dd class="tabular-nums">
              {{ time(data.blockStartsAt) }}–{{ time(data.blockEndsAt) }}
            </dd>
            <dt class="text-text-secondary">Price</dt>
            <dd class="tabular-nums">{{ money(data.price) }}</dd>
            <dt class="text-text-secondary">Paid</dt>
            <dd class="tabular-nums" data-test="paid">
              {{ money(data.paid) }}
              <span v-if="outstanding > 0" class="text-warning">
                ({{ money(outstanding) }} outstanding)
              </span>
            </dd>
            <dt class="text-text-secondary">Booked</dt>
            <dd>{{ data.origin === 'OFFICE' ? 'By the office' : 'Online' }}</dd>
            <template v-if="data.customerNote !== null">
              <dt class="text-text-secondary">Note</dt>
              <dd>{{ data.customerNote }}</dd>
            </template>
            <template v-if="data.cancellationReason !== null">
              <dt class="text-text-secondary">Cancelled because</dt>
              <dd>{{ data.cancellationReason }}</dd>
            </template>
          </dl>
        </SfCard>

        <SfCard as="section" aria-labelledby="customer-heading">
          <h2 id="customer-heading" class="text-lg font-medium">Customer</h2>
          <dl class="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt class="text-text-secondary">Name</dt>
            <dd>{{ data.customer.firstName }} {{ data.customer.lastName }}</dd>
            <dt class="text-text-secondary">Email</dt>
            <dd class="break-all">{{ data.customer.email }}</dd>
            <dt class="text-text-secondary">Phone</dt>
            <dd>{{ data.customer.phone ?? '—' }}</dd>
          </dl>
        </SfCard>

        <SfCard
          v-if="data.openCancellationRequest !== null || data.openRescheduleRequest !== null"
          as="section"
          aria-labelledby="requests-heading"
          class="lg:col-span-2"
        >
          <h2 id="requests-heading" class="text-lg font-medium">Waiting for a decision</h2>

          <p v-if="data.openCancellationRequest !== null" class="mt-2 text-sm">
            Cancellation asked for {{ dateTime(data.openCancellationRequest.requestedAt) }}.
            Suggested to keep
            {{ money(data.openCancellationRequest.suggestedRetainedAmountCents) }}.
            <RouterLink :to="{ name: 'office-requests' }" class="underline">Decide it</RouterLink>
          </p>

          <p v-if="data.openRescheduleRequest !== null" class="mt-2 text-sm">
            Move asked for to {{ dateTime(data.openRescheduleRequest.requestedStartsAt) }}.
            <RouterLink :to="{ name: 'office-requests' }" class="underline">Decide it</RouterLink>
          </p>
        </SfCard>

        <SfCard as="section" aria-labelledby="money-heading">
          <h2 id="money-heading" class="text-lg font-medium">Money</h2>

          <ul class="mt-3 space-y-1 text-sm" data-test="money">
            <li v-for="payment in data.payments" :key="payment.id" class="flex justify-between">
              <span>Card · {{ payment.status }}</span>
              <span class="tabular-nums">{{ money(payment.amount) }}</span>
            </li>
            <li
              v-for="payment in data.manualPayments"
              :key="payment.id"
              class="flex justify-between"
            >
              <span>
                {{ payment.method }}
                <span v-if="payment.note !== null" class="text-text-secondary">
                  · {{ payment.note }}
                </span>
              </span>
              <span class="tabular-nums">{{ money(payment.amount) }}</span>
            </li>
            <li v-for="refund in data.refunds" :key="refund.id" class="flex justify-between">
              <span>Refund · {{ refund.reason }} · {{ refund.status }}</span>
              <span class="tabular-nums">−{{ money(refund.amount) }}</span>
            </li>
            <li
              v-if="data.payments.length + data.manualPayments.length + data.refunds.length === 0"
              class="text-text-secondary"
            >
              Nothing recorded yet.
            </li>
          </ul>
        </SfCard>

        <SfCard as="section" aria-labelledby="notifications-heading">
          <h2 id="notifications-heading" class="text-lg font-medium">Messages sent</h2>

          <ul class="mt-3 space-y-1 text-sm" data-test="notifications">
            <li
              v-for="notification in data.notifications"
              :key="notification.id"
              class="flex justify-between gap-2"
            >
              <span>{{ notification.kind }} · {{ notification.channel }}</span>
              <span
                class="text-text-secondary"
                :class="notification.status === 'FAILED' ? 'text-danger' : ''"
              >
                {{ notification.status }}
              </span>
            </li>
            <li v-if="data.notifications.length === 0" class="text-text-secondary">
              Nothing sent yet.
            </li>
          </ul>
        </SfCard>

        <SfCard as="section" aria-labelledby="history-heading" class="lg:col-span-2">
          <h2 id="history-heading" class="text-lg font-medium">History</h2>

          <ol class="mt-3 space-y-1 text-sm" data-test="history">
            <li v-for="entry in data.statusHistory" :key="entry.id" class="flex flex-wrap gap-x-3">
              <span class="tabular-nums text-text-secondary">{{ dateTime(entry.createdAt) }}</span>
              <span>{{ entry.fromStatus ?? 'created' }} → {{ entry.toStatus }}</span>
              <span class="text-text-secondary">{{ entry.actorType }}</span>
              <span v-if="entry.reason !== null" class="text-text-secondary">
                {{ entry.reason }}
              </span>
            </li>
          </ol>
        </SfCard>
      </div>
    </template>

    <!-- Confirmations. Each restates what will happen, in numbers rather than in prose. -->
    <SfModal
      :open="dialog === 'complete'"
      title="Mark this appointment completed?"
      confirm-label="Mark completed"
      :busy="action.busy.value"
      @close="close"
      @confirm="confirmComplete"
    >
      <p>
        {{ data?.customer.firstName }} {{ data?.customer.lastName }} came in on
        {{ data === null ? '' : dateTime(data.startsAt) }}. This records the appointment as held.
      </p>
    </SfModal>

    <SfModal
      :open="dialog === 'no-show'"
      title="Mark this appointment as a no show?"
      confirm-label="Mark no show"
      confirm-variant="danger"
      :busy="action.busy.value"
      @close="close"
      @confirm="confirmNoShow"
    >
      <p>
        This records that {{ data?.customer.firstName }} {{ data?.customer.lastName }} did not
        arrive. It does not refund anything.
      </p>
    </SfModal>

    <SfModal
      :open="dialog === 'cancel'"
      title="Cancel this booking?"
      confirm-label="Cancel booking"
      confirm-variant="danger"
      :busy="action.busy.value"
      @close="close"
      @confirm="cancelValid ? confirmCancel() : undefined"
    >
      <div class="space-y-3">
        <p>
          The slot is freed and the customer is told. They have paid
          {{ data === null ? '' : money(data.paid) }}.
        </p>

        <SfInput
          v-model="cancelReason"
          label="Reason (the customer sees this)"
          data-test="cancel-reason"
          required
        />

        <SfInput
          v-if="session.can('refund.issue') && (data?.paid.amountCents ?? 0) > 0"
          v-model="cancelRefundEuros"
          label="Refund (euros, leave empty for none)"
          inputmode="decimal"
          data-test="cancel-refund"
        />

        <p v-if="cancelRefundCents !== null && cancelRefundCents > 0" data-test="cancel-preview">
          {{ money(cancelRefundCents) }} will go back to the customer.
        </p>
      </div>
    </SfModal>

    <SfModal
      :open="dialog === 'payment'"
      title="Record a payment"
      confirm-label="Record payment"
      :busy="action.busy.value"
      @close="close"
      @confirm="paymentValid ? confirmPayment() : undefined"
    >
      <div class="space-y-3">
        <p v-if="outstanding > 0">{{ money(outstanding) }} is outstanding on this booking.</p>

        <SfInput
          v-model="paymentEuros"
          label="Amount (euros, negative to correct a mistake)"
          inputmode="decimal"
          data-test="payment-amount"
        />

        <SfSelect
          :model-value="paymentMethod"
          label="Method"
          :options="PAYMENT_METHODS"
          data-test="payment-method"
          @update:model-value="(value) => (paymentMethod = value as typeof paymentMethod)"
        />

        <SfInput
          v-model="paymentNote"
          label="Note"
          data-test="payment-note"
          :required="(paymentCents ?? 0) < 0"
        />

        <p v-if="(paymentCents ?? 0) < 0 && paymentNote.trim() === ''" class="text-danger text-sm">
          A correction needs a note explaining it.
        </p>
      </div>
    </SfModal>

    <SfModal
      :open="dialog === 'refund'"
      title="Refund the customer"
      confirm-label="Send refund"
      confirm-variant="danger"
      :busy="action.busy.value"
      @close="close"
      @confirm="refundValid ? confirmRefund() : undefined"
    >
      <div class="space-y-3">
        <p>They have paid {{ data === null ? '' : money(data.paid) }}.</p>

        <SfInput
          v-model="refundEuros"
          label="Amount (euros)"
          inputmode="decimal"
          data-test="refund-amount"
        />

        <SfSelect
          :model-value="refundReason"
          label="Reason"
          :options="REFUND_REASONS"
          data-test="refund-reason"
          @update:model-value="(value) => (refundReason = value as typeof refundReason)"
        />

        <p v-if="refundCents !== null && refundValid" data-test="refund-preview">
          {{ money(refundCents) }} will go back to {{ data?.customer.firstName }}
          {{ data?.customer.lastName }}.
        </p>
        <p
          v-else-if="refundCents !== null && data !== null && refundCents > data.paid.amountCents"
          class="text-danger text-sm"
        >
          That is more than they paid.
        </p>
      </div>
    </SfModal>
  </section>
</template>
