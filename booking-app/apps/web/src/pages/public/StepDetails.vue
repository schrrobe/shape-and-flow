<script setup lang="ts">
import { CUSTOMER_NOTE_MAX_LENGTH } from '@shape-and-flow/booking-contracts';
import { SfAlert, SfButton, SfCard, SfInput, SfTextarea } from '@shape-and-flow/booking-ui';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';

import { api } from '../../api/client.js';
import { ApiError } from '../../api/errors.js';
import { messageKeyFor } from '../../api/errors.js';
import { useFocusStep } from '../../composables/useFocusStep.js';
import { useMoney } from '../../i18n/money.js';
import { useBookingDraft } from '../../stores/booking-draft.js';
import { useLocaleStore } from '../../stores/locale.js';

const { t, d } = useI18n();
const { money } = useMoney();
const router = useRouter();
const draft = useBookingDraft();
const locale = useLocaleStore();
useFocusStep(t('booking.stepDetails'));

const submitting = ref(false);
const errorKey = ref<string | null>(null);
const retryAfterSeconds = ref<number | null>(null);

const emailValid = computed(() => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email.trim()));

const complete = computed(
  () =>
    draft.firstName.trim() !== '' &&
    draft.lastName.trim() !== '' &&
    emailValid.value &&
    draft.slot !== null,
);

/**
 * Where a failure sends the customer.
 *
 * Every one of these is a real answer rather than a generic error page. A taken slot means the
 * time is gone and the list needs reloading; a spent idempotency key means this attempt cannot be
 * completed at all and only a fresh one will work.
 */
async function submit(): Promise<void> {
  const startsAt = draft.slot;

  // Narrowed rather than defaulted: a fallback of "now" would book the wrong appointment, and
  // `complete` already guarantees a slot is chosen.
  if (!complete.value || submitting.value || startsAt === null) return;

  submitting.value = true;
  errorKey.value = null;
  retryAfterSeconds.value = null;

  try {
    const created = await api.public.createBooking(
      {
        serviceId: draft.serviceId ?? '',
        employeeId: draft.employeeId,
        startsAt: startsAt.toISOString(),
        customer: {
          email: draft.email.trim(),
          firstName: draft.firstName.trim(),
          lastName: draft.lastName.trim(),
          ...(draft.phone.trim() === '' ? {} : { phone: draft.phone.trim() }),
        },
        locale: locale.current,
        ...(draft.note.trim() === '' ? {} : { customerNote: draft.note.trim() }),
        // Absolute, because Stripe redirects the browser to them. The placeholder is Stripe's
        // own: it substitutes the real session id, which is how the landing page knows which
        // payment to resolve. The API validates only the origin, so the braces survive.
        successUrl: `${window.location.origin}/booking/success?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${window.location.origin}/booking/canceled`,
      },
      draft.idempotencyKey ?? '',
    );

    draft.setReservation(created);
    await router.push({ name: 'booking-checkout' });
    return;
  } catch (error) {
    errorKey.value = messageKeyFor(error);

    if (!(error instanceof ApiError)) return;

    retryAfterSeconds.value = error.retryAfterSeconds ?? null;

    if (error.code === 'SLOT_UNAVAILABLE' || error.code === 'OUTSIDE_BOOKING_WINDOW') {
      // The time is gone. Back to the slot step, with the customer's details intact — they did
      // nothing wrong and should not retype their name.
      draft.clearSlot();
      await router.push({ name: 'booking-slot' });
      return;
    }

    if (error.code === 'IDEMPOTENCY_KEY_REUSED') {
      // The key was already spent on a different payload, so this attempt can never succeed.
      // A fresh attempt is the only way forward.
      draft.reset();
      draft.begin();
      await router.push({ name: 'booking-service' });
    }
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="flex flex-col gap-5">
    <h1 ref="heading" tabindex="-1" class="text-xl font-semibold tracking-tight outline-none">
      {{ t('booking.detailsTitle') }}
    </h1>

    <SfAlert v-if="errorKey !== null" tone="danger" data-test="error" :title="t('errors.title')">
      {{ t(errorKey, { seconds: retryAfterSeconds ?? 60 }) }}
    </SfAlert>

    <form class="flex flex-col gap-4" @submit.prevent="submit">
      <div class="grid gap-4 sm:grid-cols-2">
        <SfInput
          v-model="draft.firstName"
          data-test="first-name"
          :label="t('booking.firstName')"
          autocomplete="given-name"
          required
        />
        <SfInput
          v-model="draft.lastName"
          data-test="last-name"
          :label="t('booking.lastName')"
          autocomplete="family-name"
          required
        />
      </div>

      <SfInput
        v-model="draft.email"
        data-test="email"
        type="email"
        :label="t('booking.email')"
        :description="t('booking.emailHint')"
        :error="draft.email.trim() === '' || emailValid ? null : t('errors.VALIDATION_FAILED')"
        autocomplete="email"
        required
      />

      <SfInput
        v-model="draft.phone"
        data-test="phone"
        type="tel"
        :label="t('booking.phone')"
        :description="t('booking.phoneHint')"
        autocomplete="tel"
      />

      <SfTextarea
        v-model="draft.note"
        data-test="note"
        :label="t('booking.note')"
        :description="t('booking.notePrivacyHint')"
        :maxlength="CUSTOMER_NOTE_MAX_LENGTH"
      />

      <SfCard as="section" class="bg-surface-muted">
        <h2 class="font-semibold">{{ t('booking.summaryTitle') }}</h2>
        <dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt class="text-text-secondary">{{ t('booking.summaryService') }}</dt>
          <dd>{{ draft.serviceName }}</dd>

          <dt class="text-text-secondary">{{ t('booking.summaryEmployee') }}</dt>
          <dd data-test="summary-employee">{{ draft.employeeName ?? t('booking.employeeAny') }}</dd>

          <dt class="text-text-secondary">{{ t('booking.summaryTime') }}</dt>
          <dd v-if="draft.slot !== null" data-test="summary-time">{{ d(draft.slot, 'full') }}</dd>

          <dt class="text-text-secondary">{{ t('booking.summaryPrice') }}</dt>
          <dd v-if="draft.servicePriceCents !== null" data-test="summary-price">
            {{ money(draft.servicePriceCents) }}
          </dd>
        </dl>
        <p class="mt-3 text-sm text-text-secondary">
          {{ t('booking.reservationHint', { minutes: 5 }) }}
        </p>
      </SfCard>

      <div class="flex flex-wrap gap-2">
        <SfButton variant="ghost" @click="router.push({ name: 'booking-slot' })">
          {{ t('common.back') }}
        </SfButton>
        <SfButton
          type="submit"
          data-test="submit"
          :loading="submitting"
          :disabled="!complete"
          :loading-label="t('booking.submitting')"
        >
          {{ t('booking.submit') }}
        </SfButton>
      </div>
    </form>
  </div>
</template>
