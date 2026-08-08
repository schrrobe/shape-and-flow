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
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';

import { api } from '../../api/client.js';
import { STATUS_PRESENTATION } from '../../components/office/status-presentation.js';
import StatusBadge from '../../components/office/StatusBadge.vue';
import { useAsyncData } from '../../composables/useAsyncData.js';
import { useFocusStep } from '../../composables/useFocusStep.js';
import { dateTime, difference, hasPassed, money, time } from '../../office/format.js';
import { registerOfficeMessages } from '../../office/i18n/index.js';
import { officeMessage } from '../../office/messages.js';
import { useOfficeAction } from '../../office/useOfficeAction.js';
import { useSession } from '../../stores/session.js';

import type { PaymentStatus, RefundReason, RefundStatus } from '@shape-and-flow/booking-contracts';

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
registerOfficeMessages();

const route = useRoute();
const session = useSession();
const { t } = useI18n();

useFocusStep('Booking');

const id = computed(() => String(route.params.id));

const { data, errorKey, loading, run } = useAsyncData((signal) =>
  api.office.bookings.detail(id.value, signal),
);

const action = useOfficeAction(run);

/** Which confirmation is open. `null` means none. */
const dialog = ref<'complete' | 'no-show' | 'cancel' | 'payment' | 'refund' | null>(null);

const PAYMENT_METHODS = computed(() => [
  { value: 'CASH', label: t('office.bookingDetail.paymentMethodCash') },
  { value: 'CARD', label: t('office.bookingDetail.paymentMethodCard') },
  { value: 'BANK_TRANSFER', label: t('office.bookingDetail.paymentMethodBankTransfer') },
  { value: 'OTHER', label: t('office.bookingDetail.paymentMethodOther') },
]);

/**
 * The three an office actually picks from.
 *
 * `CUSTOMER_CANCELLATION` is deliberately absent: that reason belongs to the
 * cancellation flow, which records it automatically, and offering it here would let
 * somebody file a goodwill refund under a decision the customer never made.
 */
const REFUND_REASONS = computed(() => [
  { value: 'GOODWILL', label: t('office.bookingDetail.refundReasonGoodwill') },
  {
    value: 'BUSINESS_CANCELLATION',
    label: t('office.bookingDetail.refundReasonBusinessCancellation'),
  },
  { value: 'DUPLICATE_PAYMENT', label: t('office.bookingDetail.refundReasonDuplicatePayment') },
]);

/** Every reason a refund can carry, including `CUSTOMER_CANCELLATION` — recorded
 * automatically by the cancellation flow, so absent from `REFUND_REASONS` above but still
 * something the history list must be able to display. */
const REFUND_REASON_LABEL_KEYS: Record<RefundReason, string> = {
  CUSTOMER_CANCELLATION: 'office.bookingDetail.refundReasonCustomerCancellation',
  BUSINESS_CANCELLATION: 'office.bookingDetail.refundReasonBusinessCancellation',
  GOODWILL: 'office.bookingDetail.refundReasonGoodwill',
  DUPLICATE_PAYMENT: 'office.bookingDetail.refundReasonDuplicatePayment',
};

const PAYMENT_STATUS_LABEL_KEYS: Record<PaymentStatus, string> = {
  PENDING: 'office.status.paymentStatusPending',
  SUCCEEDED: 'office.status.paymentStatusSucceeded',
  FAILED: 'office.status.paymentFailed',
  PARTIALLY_REFUNDED: 'office.status.paymentStatusPartiallyRefunded',
  REFUNDED: 'office.status.paymentStatusRefunded',
};

const REFUND_STATUS_LABEL_KEYS: Record<RefundStatus, string> = {
  PENDING: 'office.status.refundStatusPending',
  SUCCEEDED: 'office.status.refundStatusSucceeded',
  FAILED: 'office.status.refundStatusFailed',
  CANCELED: 'office.status.refundStatusCanceled',
};

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
 * One idempotency key per intended operation, held across retries of it.
 *
 * Not per attempt. Retries here are always the operator's, and the usual reason to retry
 * is exactly the case the key exists for: the server took the payment or sent the refund
 * and the response never arrived. A fresh key on the second click makes that a second
 * operation, and the money moves twice. Replaying the server's stored answer — including
 * a refusal — is the correct outcome, because the server has already decided.
 *
 * A changed amount, method, note or reason *is* a different operation, so the key is
 * dropped whenever one of them changes, and again once a dialog closes.
 */
const attemptKey = ref<string | null>(null);

function currentKey(): string {
  attemptKey.value ??= crypto.randomUUID();

  return attemptKey.value;
}

watch(
  [
    cancelReason,
    cancelRefundEuros,
    paymentEuros,
    paymentMethod,
    paymentNote,
    refundEuros,
    refundReason,
  ],
  () => {
    attemptKey.value = null;
  },
);

function close(): void {
  dialog.value = null;
  attemptKey.value = null;
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
    api.office.bookings.cancel(
      id.value,
      {
        reason: cancelReason.value.trim(),
        ...(cancelRefundEuros.value.trim() === '' || refund === null
          ? {}
          : { refund: { amountCents: refund } }),
      },
      currentKey(),
    ),
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
      currentKey(),
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
      currentKey(),
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
          {{ t('office.bookingDetail.markCompleted') }}
        </SfButton>

        <SfButton
          v-if="session.can('booking.complete') && isLive && isPast"
          variant="secondary"
          data-test="action-no-show"
          @click="dialog = 'no-show'"
        >
          {{ t('office.bookingDetail.markNoShow') }}
        </SfButton>

        <SfButton
          v-if="session.can('payment.recordManual')"
          variant="secondary"
          data-test="action-payment"
          @click="dialog = 'payment'"
        >
          {{ t('office.bookingDetail.recordPayment') }}
        </SfButton>

        <SfButton
          v-if="session.can('refund.issue') && data.paid.amountCents > 0"
          variant="secondary"
          data-test="action-refund"
          @click="dialog = 'refund'"
        >
          {{ t('office.bookingDetail.refund') }}
        </SfButton>

        <SfButton
          v-if="session.can('booking.cancel') && isLive"
          variant="danger"
          data-test="action-cancel"
          @click="dialog = 'cancel'"
        >
          {{ t('office.bookingDetail.cancelBooking') }}
        </SfButton>
      </div>

      <div class="grid gap-4 lg:grid-cols-2">
        <SfCard as="section" aria-labelledby="summary-heading">
          <h2 id="summary-heading" class="text-lg font-medium">
            {{ t('office.bookingDetail.appointmentHeading') }}
          </h2>
          <dl class="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt class="text-text-secondary">{{ t('office.bookingDetail.treatment') }}</dt>
            <dd>{{ data.serviceName }} ({{ data.durationMinutes }} min)</dd>
            <dt class="text-text-secondary">{{ t('office.bookingDetail.blocked') }}</dt>
            <dd class="tabular-nums">
              {{ time(data.blockStartsAt) }}–{{ time(data.blockEndsAt) }}
            </dd>
            <dt class="text-text-secondary">{{ t('office.bookingDetail.price') }}</dt>
            <dd class="tabular-nums">{{ money(data.price) }}</dd>
            <dt class="text-text-secondary">{{ t('office.bookingDetail.paid') }}</dt>
            <dd class="tabular-nums" data-test="paid">
              {{ money(data.paid) }}
              <span v-if="outstanding > 0" class="text-warning">
                {{ t('office.bookingDetail.outstandingAmount', { amount: money(outstanding) }) }}
              </span>
            </dd>
            <dt class="text-text-secondary">{{ t('office.bookingDetail.booked') }}</dt>
            <dd>
              {{
                data.origin === 'OFFICE'
                  ? t('office.bookingDetail.bookedByOffice')
                  : t('office.bookingDetail.bookedOnline')
              }}
            </dd>
            <template v-if="data.customerNote !== null">
              <dt class="text-text-secondary">{{ t('office.bookingDetail.note') }}</dt>
              <dd>{{ data.customerNote }}</dd>
            </template>
            <template v-if="data.cancellationReason !== null">
              <dt class="text-text-secondary">{{ t('office.bookingDetail.cancelledBecause') }}</dt>
              <dd>{{ data.cancellationReason }}</dd>
            </template>
          </dl>
        </SfCard>

        <SfCard as="section" aria-labelledby="customer-heading">
          <h2 id="customer-heading" class="text-lg font-medium">
            {{ t('office.bookingDetail.customerHeading') }}
          </h2>
          <dl class="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt class="text-text-secondary">{{ t('office.bookingDetail.name') }}</dt>
            <dd>{{ data.customer.firstName }} {{ data.customer.lastName }}</dd>
            <dt class="text-text-secondary">{{ t('office.bookingDetail.email') }}</dt>
            <dd class="break-all">{{ data.customer.email }}</dd>
            <dt class="text-text-secondary">{{ t('office.bookingDetail.phone') }}</dt>
            <dd>{{ data.customer.phone ?? '—' }}</dd>
          </dl>
        </SfCard>

        <SfCard
          v-if="data.openCancellationRequest !== null || data.openRescheduleRequest !== null"
          as="section"
          aria-labelledby="requests-heading"
          class="lg:col-span-2"
        >
          <h2 id="requests-heading" class="text-lg font-medium">
            {{ t('office.bookingDetail.waitingForDecisionHeading') }}
          </h2>

          <p v-if="data.openCancellationRequest !== null" class="mt-2 text-sm">
            {{
              t('office.bookingDetail.cancellationRequestSummary', {
                date: dateTime(data.openCancellationRequest.requestedAt),
                amount: money(data.openCancellationRequest.suggestedRetainedAmountCents),
              })
            }}
            <RouterLink :to="{ name: 'office-requests' }" class="underline">{{
              t('office.bookingDetail.decideIt')
            }}</RouterLink>
          </p>

          <p v-if="data.openRescheduleRequest !== null" class="mt-2 text-sm">
            {{
              t('office.bookingDetail.moveRequestSummary', {
                date: dateTime(data.openRescheduleRequest.requestedStartsAt),
              })
            }}
            <RouterLink :to="{ name: 'office-requests' }" class="underline">{{
              t('office.bookingDetail.decideIt')
            }}</RouterLink>
          </p>
        </SfCard>

        <SfCard as="section" aria-labelledby="money-heading">
          <h2 id="money-heading" class="text-lg font-medium">
            {{ t('office.bookingDetail.moneyHeading') }}
          </h2>

          <ul class="mt-3 space-y-1 text-sm" data-test="money">
            <li v-for="payment in data.payments" :key="payment.id" class="flex justify-between">
              <span>
                {{ t('office.bookingDetail.cardPayment') }} ·
                {{ t(PAYMENT_STATUS_LABEL_KEYS[payment.status]) }}
              </span>
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
              <span>
                {{ t('office.bookingDetail.refund') }} ·
                {{ t(REFUND_REASON_LABEL_KEYS[refund.reason]) }} ·
                {{ t(REFUND_STATUS_LABEL_KEYS[refund.status]) }}
              </span>
              <span class="tabular-nums">−{{ money(refund.amount) }}</span>
            </li>
            <li
              v-if="data.payments.length + data.manualPayments.length + data.refunds.length === 0"
              class="text-text-secondary"
            >
              {{ t('office.bookingDetail.nothingRecordedYet') }}
            </li>
          </ul>
        </SfCard>

        <SfCard as="section" aria-labelledby="notifications-heading">
          <h2 id="notifications-heading" class="text-lg font-medium">
            {{ t('office.bookingDetail.messagesSentHeading') }}
          </h2>

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
              {{ t('office.bookingDetail.nothingSentYet') }}
            </li>
          </ul>
        </SfCard>

        <SfCard as="section" aria-labelledby="history-heading" class="lg:col-span-2">
          <h2 id="history-heading" class="text-lg font-medium">
            {{ t('office.bookingDetail.historyHeading') }}
          </h2>

          <ol class="mt-3 space-y-1 text-sm" data-test="history">
            <li v-for="entry in data.statusHistory" :key="entry.id" class="flex flex-wrap gap-x-3">
              <span class="tabular-nums text-text-secondary">{{ dateTime(entry.createdAt) }}</span>
              <span>
                {{
                  entry.fromStatus === null
                    ? t('office.bookingDetail.created')
                    : t(STATUS_PRESENTATION[entry.fromStatus].labelKey)
                }}
                → {{ t(STATUS_PRESENTATION[entry.toStatus].labelKey) }}
              </span>
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
      :title="t('office.bookingDetail.completedTitle')"
      :confirm-label="t('office.bookingDetail.markCompleted')"
      :busy="action.busy.value"
      @close="close"
      @confirm="confirmComplete"
    >
      <p>
        {{
          t('office.bookingDetail.completedBody', {
            customer: `${data?.customer.firstName} ${data?.customer.lastName}`,
            date: data === null ? '' : dateTime(data.startsAt),
          })
        }}
      </p>
    </SfModal>

    <SfModal
      :open="dialog === 'no-show'"
      :title="t('office.bookingDetail.noShowTitle')"
      :confirm-label="t('office.bookingDetail.markNoShow')"
      confirm-variant="danger"
      :busy="action.busy.value"
      @close="close"
      @confirm="confirmNoShow"
    >
      <p>
        {{
          t('office.bookingDetail.noShowBody', {
            customer: `${data?.customer.firstName} ${data?.customer.lastName}`,
          })
        }}
      </p>
    </SfModal>

    <SfModal
      :open="dialog === 'cancel'"
      :title="t('office.bookingDetail.cancelBookingTitle')"
      :confirm-label="t('office.bookingDetail.cancelBooking')"
      confirm-variant="danger"
      :busy="action.busy.value"
      :confirm-disabled="!cancelValid"
      @close="close"
      @confirm="cancelValid ? confirmCancel() : undefined"
    >
      <div class="space-y-3">
        <p>
          {{
            t('office.bookingDetail.cancelIntro', {
              amount: data === null ? '' : money(data.paid),
            })
          }}
        </p>

        <SfInput
          v-model="cancelReason"
          :label="t('office.bookingDetail.cancelReasonLabel')"
          data-test="cancel-reason"
          required
        />

        <SfInput
          v-if="session.can('refund.issue') && (data?.paid.amountCents ?? 0) > 0"
          v-model="cancelRefundEuros"
          :label="t('office.bookingDetail.cancelRefundLabel')"
          inputmode="decimal"
          data-test="cancel-refund"
        />

        <p v-if="cancelRefundCents !== null && cancelRefundCents > 0" data-test="cancel-preview">
          {{ t('office.bookingDetail.cancelRefundPreview', { amount: money(cancelRefundCents) }) }}
        </p>

        <!-- Said rather than only enforced: a confirm button that ignores the click leaves
             the operator looking for what they did wrong. -->
        <p v-if="cancelReason.trim() === ''" class="text-danger text-sm" data-test="cancel-invalid">
          {{ t('office.bookingDetail.cancelReasonRequired') }}
        </p>
        <p
          v-else-if="
            cancelRefundEuros.trim() !== '' && (cancelRefundCents === null || cancelRefundCents < 0)
          "
          class="text-danger text-sm"
          data-test="cancel-invalid"
        >
          {{ t('office.bookingDetail.cancelRefundInvalid') }}
        </p>
      </div>
    </SfModal>

    <SfModal
      :open="dialog === 'payment'"
      :title="t('office.bookingDetail.recordPaymentTitle')"
      :confirm-label="t('office.bookingDetail.recordPayment')"
      :busy="action.busy.value"
      :confirm-disabled="!paymentValid"
      @close="close"
      @confirm="paymentValid ? confirmPayment() : undefined"
    >
      <div class="space-y-3">
        <p v-if="outstanding > 0">
          {{ t('office.bookingDetail.outstandingOnBooking', { amount: money(outstanding) }) }}
        </p>

        <SfInput
          v-model="paymentEuros"
          :label="t('office.bookingDetail.paymentAmountLabel')"
          inputmode="decimal"
          data-test="payment-amount"
        />

        <SfSelect
          :model-value="paymentMethod"
          :label="t('office.bookingDetail.methodLabel')"
          :options="PAYMENT_METHODS"
          data-test="payment-method"
          @update:model-value="(value) => (paymentMethod = value as typeof paymentMethod)"
        />

        <SfInput
          v-model="paymentNote"
          :label="t('office.bookingDetail.note')"
          data-test="payment-note"
          :required="(paymentCents ?? 0) < 0"
        />

        <!-- Empty is not wrong, it is unfilled: nothing is said until something is typed. -->
        <p
          v-if="paymentEuros.trim() !== '' && paymentCents === null"
          class="text-danger text-sm"
          data-test="payment-invalid"
        >
          {{ t('office.bookingDetail.notEuroAmount') }}
        </p>
        <p v-else-if="paymentCents === 0" class="text-danger text-sm" data-test="payment-invalid">
          {{ t('office.bookingDetail.zeroNotPayment') }}
        </p>
        <p
          v-else-if="(paymentCents ?? 0) < 0 && paymentNote.trim() === ''"
          class="text-danger text-sm"
          data-test="payment-invalid"
        >
          {{ t('office.bookingDetail.correctionNeedsNote') }}
        </p>
      </div>
    </SfModal>

    <SfModal
      :open="dialog === 'refund'"
      :title="t('office.bookingDetail.refundTitle')"
      :confirm-label="t('office.bookingDetail.sendRefund')"
      confirm-variant="danger"
      :busy="action.busy.value"
      :confirm-disabled="!refundValid"
      @close="close"
      @confirm="refundValid ? confirmRefund() : undefined"
    >
      <div class="space-y-3">
        <p>
          {{
            t('office.bookingDetail.theyHavePaid', {
              amount: data === null ? '' : money(data.paid),
            })
          }}
        </p>

        <SfInput
          v-model="refundEuros"
          :label="t('office.bookingDetail.amountEurosLabel')"
          inputmode="decimal"
          data-test="refund-amount"
        />

        <SfSelect
          :model-value="refundReason"
          :label="t('office.bookingDetail.reasonLabel')"
          :options="REFUND_REASONS"
          data-test="refund-reason"
          @update:model-value="(value) => (refundReason = value as typeof refundReason)"
        />

        <p v-if="refundCents !== null && refundValid" data-test="refund-preview">
          {{
            t('office.bookingDetail.refundPreview', {
              amount: money(refundCents),
              customer: `${data?.customer.firstName} ${data?.customer.lastName}`,
            })
          }}
        </p>
        <p
          v-else-if="refundCents !== null && data !== null && refundCents > data.paid.amountCents"
          class="text-danger text-sm"
          data-test="refund-invalid"
        >
          {{ t('office.bookingDetail.moreThanPaid') }}
        </p>
        <p
          v-else-if="refundEuros.trim() !== '' && refundCents === null"
          class="text-danger text-sm"
          data-test="refund-invalid"
        >
          {{ t('office.bookingDetail.notEuroAmount') }}
        </p>
        <p
          v-else-if="refundCents !== null && refundCents <= 0"
          class="text-danger text-sm"
          data-test="refund-invalid"
        >
          {{ t('office.bookingDetail.refundMoreThanNothing') }}
        </p>
      </div>
    </SfModal>
  </section>
</template>
