<script setup lang="ts">
import {
  SfAlert,
  SfBadge,
  SfButton,
  SfCard,
  SfModal,
  SfSkeleton,
  SfTextarea,
} from '@shape-and-flow/booking-ui';
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';

import { api } from '../../api/client.js';
import { ApiError, messageKeyFor } from '../../api/errors.js';
import WhatsAppButton from '../../components/WhatsAppButton.vue';
import { useAsyncData } from '../../composables/useAsyncData.js';
import { useFocusStep } from '../../composables/useFocusStep.js';
import { useManagementToken } from '../../composables/useManagementToken.js';
import { useMoney } from '../../i18n/money.js';

import type { ManageCancelResponse } from '@shape-and-flow/booking-contracts';

const { t, d } = useI18n();
const { money } = useMoney();
useFocusStep(t('manage.title'));

const { token, missing } = useManagementToken();

const {
  data: booking,
  errorKey,
  loading,
  run,
} = useAsyncData((signal) => api.manage.booking(token.value ?? '', signal));

const { data: organization, run: loadOrganization } = useAsyncData((signal) =>
  api.public.organization(signal),
);

const confirmOpen = ref(false);
const cancelling = ref(false);
const cancelReason = ref('');
const cancelError = ref<string | null>(null);
const outcome = ref<ManageCancelResponse | null>(null);

onMounted(() => {
  // No token means no request: an unauthenticated call would return a 401 that says nothing more
  // than "your link is incomplete" already does.
  if (missing.value) return;

  void run();
  void loadOrganization();
});

/**
 * A 401 from any `/manage` call is an expired link, not an error.
 *
 * The token has a lifetime, and a customer opening an old email is the normal way to meet that
 * lifetime. Showing them a raw failure invites a support message about a working system.
 */
const linkDead = computed(() => missing.value || errorKey.value === 'errors.UNAUTHENTICATED');

const policy = computed(() => booking.value?.cancellationPolicy ?? null);

/**
 * What the customer will be told *before* they confirm, not after.
 *
 * Keyed on the retained *amount*, not only on `feeApplies`. A business can be inside its fee window
 * and still keep nothing — a zero percentage, or a policy of `NONE` — and "we keep 0,00 €" is a
 * sentence that makes a customer read it three times. Seen on the real page, not in a test.
 */
const consequence = computed(() => {
  const current = policy.value;
  if (current === null) return '';

  if (current.suggestedRetained.amountCents === 0) {
    return t('manage.cancelFree', { amount: money(current.suggestedRefund) });
  }

  return t('manage.cancelWithFee', {
    retained: money(current.suggestedRetained),
    refund: money(current.suggestedRefund),
  });
});

/**
 * What was refunded — or that the amount is not settled yet.
 *
 * `refundExpected` is nullable, and a null means the server did not state an amount. It does
 * not mean zero, and substituting one would have the page promise `0,00 €` to somebody who is
 * owed money. The currency comes from the server's own figure for the same reason: there is
 * no reason for this page to hold an opinion about it.
 */
const canceledBody = computed(() => {
  const refund = outcome.value?.refundExpected ?? null;
  if (refund === null) return t('manage.canceledBodyRefundPending');

  return t('manage.canceledBody', { amount: money(refund) });
});

async function cancel(): Promise<void> {
  if (cancelling.value) return;

  cancelling.value = true;
  cancelError.value = null;

  try {
    outcome.value = await api.manage.cancel(token.value ?? '', {
      ...(cancelReason.value.trim() === '' ? {} : { reason: cancelReason.value.trim() }),
    });

    confirmOpen.value = false;
    // Re-read rather than patch the local copy: the server decides the status, the refund and
    // whether a request was opened, and a guessed status is a lie on a page about money.
    await run();
  } catch (error) {
    cancelError.value = messageKeyFor(error);
    if (error instanceof ApiError && error.code === 'UNAUTHENTICATED') confirmOpen.value = false;
  } finally {
    cancelling.value = false;
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <SfCard v-if="linkDead" as="section" data-test="link-expired">
      <h1 ref="heading" tabindex="-1" class="text-xl font-semibold outline-none">
        {{ t('manage.missingTitle') }}
      </h1>
      <p class="mt-2 text-text-secondary">{{ t('manage.missingBody') }}</p>
    </SfCard>

    <template v-else>
      <SfCard as="section">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <h1 ref="heading" tabindex="-1" class="text-xl font-semibold outline-none">
            {{ t('manage.title') }}
          </h1>
          <SfBadge
            v-if="booking !== null"
            :tone="booking.status === 'CONFIRMED' ? 'success' : 'neutral'"
          >
            {{ booking.displayStatus }}
          </SfBadge>
        </div>

        <SfSkeleton v-if="loading && booking === null" class="mt-4" :lines="4" />

        <SfAlert v-else-if="errorKey !== null && booking === null" tone="danger" class="mt-4">
          {{ t(errorKey) }}
        </SfAlert>

        <dl v-else-if="booking !== null" class="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt class="text-text-secondary">{{ t('success.reference') }}</dt>
          <dd class="font-mono" data-test="reference">{{ booking.reference }}</dd>

          <dt class="text-text-secondary">{{ t('booking.summaryService') }}</dt>
          <dd>{{ booking.serviceName }}</dd>

          <dt class="text-text-secondary">{{ t('booking.summaryEmployee') }}</dt>
          <dd>{{ booking.employeeDisplayName }}</dd>

          <dt class="text-text-secondary">{{ t('booking.summaryTime') }}</dt>
          <dd>{{ d(new Date(booking.startsAt), 'full') }}</dd>

          <dt class="text-text-secondary">{{ t('booking.summaryPrice') }}</dt>
          <dd>{{ money(booking.price) }}</dd>
        </dl>
      </SfCard>

      <!-- The outcome of a cancellation, kept distinct. An immediate cancellation and a request the
           office still has to decide are different things, and one message for both would leave the
           customer unsure whether their appointment is gone. -->
      <SfAlert
        v-if="outcome?.outcome === 'CANCELED'"
        tone="success"
        data-test="cancel-outcome"
        :title="t('manage.canceledTitle')"
      >
        {{ canceledBody }}
      </SfAlert>

      <SfAlert
        v-else-if="outcome?.outcome === 'REQUESTED'"
        tone="info"
        data-test="request-submitted"
        :title="t('manage.requestedTitle')"
      >
        {{ t('manage.requestedBody') }}
      </SfAlert>

      <SfCard v-else-if="policy !== null" as="section">
        <h2 class="font-semibold">{{ t('manage.cancelTitle') }}</h2>

        <p v-if="!policy.cancellable" class="mt-2 text-text-secondary" data-test="not-cancellable">
          {{ t('manage.notCancellable') }}
        </p>

        <template v-else>
          <!-- The consequence is stated here, before the button, and again in the dialog. Somebody
               about to give up money should not have to press anything to find out how much. -->
          <p class="mt-2" data-test="policy-consequence">{{ consequence }}</p>
          <p v-if="policy.feeApplies" class="mt-1 text-sm text-text-secondary">
            {{ t('manage.cancelNeedsApproval') }}
          </p>

          <SfAlert v-if="cancelError !== null" tone="danger" class="mt-3">
            {{ t(cancelError) }}
          </SfAlert>

          <div class="mt-4 flex flex-wrap gap-2">
            <SfButton variant="danger" data-test="cancel" @click="confirmOpen = true">
              {{ t('manage.cancelConfirm') }}
            </SfButton>
            <RouterLink
              :to="{ name: 'manage-reschedule', hash: `#${token ?? ''}` }"
              class="inline-flex items-center rounded-sf border border-border bg-surface px-4 py-2.5 font-medium hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              {{ t('manage.rescheduleTitle') }}
            </RouterLink>
          </div>
        </template>
      </SfCard>

      <div>
        <WhatsAppButton
          :number="organization?.whatsappNumber ?? null"
          :reference="booking?.reference ?? null"
        />
      </div>

      <SfModal
        :open="confirmOpen"
        :title="t('manage.cancelConfirmQuestion')"
        :confirm-label="t('manage.cancelConfirm')"
        :cancel-label="t('common.cancel')"
        confirm-variant="danger"
        :busy="cancelling"
        @close="confirmOpen = false"
        @confirm="cancel"
      >
        <p data-test="confirm-consequence">{{ consequence }}</p>
        <div class="mt-3">
          <SfTextarea
            v-model="cancelReason"
            data-test="cancel-reason"
            :label="t('manage.cancelReason')"
            :rows="3"
          />
        </div>
      </SfModal>
    </template>
  </div>
</template>
