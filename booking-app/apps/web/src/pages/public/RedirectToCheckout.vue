<script setup lang="ts">
import { SfAlert, SfButton, SfCard } from '@shape-and-flow/booking-ui';
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';

import ReservationCountdown from '../../components/ReservationCountdown.vue';
import { useFocusStep } from '../../composables/useFocusStep.js';
import { useMoney } from '../../i18n/money.js';
import { useBookingDraft } from '../../stores/booking-draft.js';

const { t, d } = useI18n();
const { money } = useMoney();
const router = useRouter();
const draft = useBookingDraft();
useFocusStep(t('booking.checkoutTitle'));

/**
 * Long enough to read the deadline, short enough not to feel stuck.
 *
 * The pause is the point: the slot is held for five minutes, and a customer who is bounced
 * straight to Stripe discovers that only when the reservation has already lapsed.
 */
const REDIRECT_DELAY_MS = 2000;

const expired = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;

/**
 * A local copy of what this page is showing.
 *
 * Not read straight from the store, because handling expiry clears the draft — and a template
 * bound to the store then had nothing to render, so the page went blank at exactly the moment it
 * needed to explain itself. The page renders what it was handed; the draft is free to move on.
 */
const reservation = ref(draft.reservation);

onMounted(() => {
  const current = reservation.value;

  // No reservation in memory means a reload landed here — the URL was never meant to be
  // bookmarkable, and the Checkout link is deliberately not persisted.
  if (current === null) {
    void router.replace({ name: 'booking-service' });
    return;
  }

  timer = setTimeout(() => {
    // Re-checked at fire time rather than only when the timer was set. The countdown mounts before
    // this hook runs, so an already-lapsed reservation reports itself *before* there is a timer to
    // cancel — and cancelling on the event alone would still have redirected.
    if (expired.value) return;

    window.location.assign(current.checkoutUrl);
  }, REDIRECT_DELAY_MS);
});

onBeforeUnmount(() => {
  if (timer !== undefined) clearTimeout(timer);
});

/**
 * The reservation lapsed before the redirect fired: do not send them to a dead session.
 *
 * The key is rotated along with the slot. It is bound to the booking this attempt held, so
 * the next submission under it would be a spent key with a different body — refused as
 * `IDEMPOTENCY_KEY_REUSED`, which would block the customer at exactly the moment the alert
 * below invites them to pick again.
 */
function onExpired(): void {
  expired.value = true;
  if (timer !== undefined) clearTimeout(timer);
  draft.expireReservation();
}
</script>

<template>
  <div v-if="reservation !== null" class="flex flex-col gap-4">
    <h1 ref="heading" tabindex="-1" class="text-xl font-semibold tracking-tight outline-none">
      {{ t('booking.checkoutTitle') }}
    </h1>

    <p class="text-text-secondary">{{ t('booking.checkoutBody') }}</p>

    <ReservationCountdown :expires-at="new Date(reservation.expiresAt)" @expired="onExpired" />

    <SfCard as="section" class="bg-surface-muted">
      <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt class="text-text-secondary">{{ t('booking.summaryEmployee') }}</dt>
        <!-- The *resolved* employee: "anyone" became a person, and the customer should know who
             before they pay. -->
        <dd>{{ reservation.employeeDisplayName }}</dd>

        <dt class="text-text-secondary">{{ t('booking.summaryTime') }}</dt>
        <dd>{{ d(new Date(reservation.startsAt), 'full') }}</dd>

        <dt class="text-text-secondary">{{ t('booking.summaryPrice') }}</dt>
        <dd>{{ money(reservation.price) }}</dd>

        <dt class="text-text-secondary">{{ t('success.reference') }}</dt>
        <dd class="font-mono" data-test="reference">{{ reservation.reference }}</dd>
      </dl>
    </SfCard>

    <SfAlert v-if="expired" tone="danger" data-test="reservation-expired">
      {{ t('booking.countdownExpired') }}
      <div class="mt-3">
        <SfButton variant="secondary" @click="router.push({ name: 'booking-slot' })">
          {{ t('booking.slotTitle') }}
        </SfButton>
      </div>
    </SfAlert>

    <p v-else>
      <!-- A manual link as well as the redirect: a blocked `location.assign`, an extension, or a
           slow tab must not leave the customer stranded with a live reservation. -->
      <a
        data-test="checkout-link"
        :href="reservation.checkoutUrl"
        class="rounded-sf underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        {{ t('booking.checkoutManual') }}
      </a>
    </p>
  </div>
</template>
