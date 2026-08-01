<script setup lang="ts">
import { SfAlert, SfCard, SfSkeleton, SfSpinner } from '@shape-and-flow/booking-ui';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';

import { api } from '../../api/client.js';
import { messageKeyFor } from '../../api/errors.js';
import WhatsAppButton from '../../components/WhatsAppButton.vue';
import { useAsyncData } from '../../composables/useAsyncData.js';
import { useFocusStep } from '../../composables/useFocusStep.js';
import { useMoney } from '../../i18n/money.js';
import { useBookingDraft } from '../../stores/booking-draft.js';

import type { BookingBySessionResponse } from '@shape-and-flow/booking-contracts';

const { t, d } = useI18n();
const { money } = useMoney();
const route = useRoute();
const draft = useBookingDraft();
useFocusStep(t('success.confirmedTitle'));

/**
 * How long to keep asking, and how patiently.
 *
 * Confirmation comes from a Stripe webhook, so the browser is racing a server-to-server call it
 * cannot see. Usually it has already landed; occasionally it takes a few seconds. The gaps widen
 * rather than hammering a fixed interval, and the whole thing gives up after thirty seconds —
 * because past that point the honest thing to say is "we will email you", not "still loading".
 */
const POLL_DELAYS_MS = [1000, 2000, 3000, 5000, 8000, 11_000];

const booking = ref<BookingBySessionResponse | null>(null);
const errorKey = ref<string | null>(null);
/** True once polling has run out of patience without a confirmation. */
const timedOut = ref(false);

const sessionId = computed(() => {
  const value = route.query.session_id;
  return typeof value === 'string' && value !== '' ? value : null;
});

const { data: organization, run: loadOrganization } = useAsyncData((signal) =>
  api.public.organization(signal),
);

const confirmed = computed(() => booking.value?.status === 'CONFIRMED');

let controller: AbortController | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let attempt = 0;

async function poll(): Promise<void> {
  const id = sessionId.value;
  if (id === null) return;

  controller = new AbortController();

  try {
    booking.value = await api.public.bookingBySession(id, controller.signal);
  } catch (error) {
    if ((error as Error).name === 'AbortError') return;

    // A read that fails is not a failed payment. Keep polling; only say something if it never
    // resolves.
    errorKey.value = messageKeyFor(error);
  }

  if (confirmed.value) return;

  const delay = POLL_DELAYS_MS[attempt];

  if (delay === undefined) {
    timedOut.value = true;
    return;
  }

  attempt += 1;
  timer = setTimeout(() => {
    void poll();
  }, delay);
}

onMounted(() => {
  void loadOrganization();
  void poll();

  // The attempt is over, whatever the outcome: the key must not be reused for the next booking.
  draft.reset();
});

onBeforeUnmount(() => {
  controller?.abort();
  if (timer !== undefined) clearTimeout(timer);
});
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- No session id: somebody opened this page directly. Nothing to resolve, and nothing
         alarming to say about it. -->
    <SfAlert v-if="sessionId === null" tone="info" :title="t('success.slowTitle')">
      {{ t('success.slowBody') }}
    </SfAlert>

    <template v-else>
      <SfCard as="section">
        <h1 ref="heading" tabindex="-1" class="text-xl font-semibold tracking-tight outline-none">
          {{ confirmed ? t('success.confirmedTitle') : t('success.pendingTitle') }}
        </h1>

        <p v-if="confirmed" class="mt-2 text-text-secondary">
          {{ t('success.confirmedBody', { email: draft.email }) }}
        </p>

        <!-- Three states, and the third never claims failure. A payment that has not been
             confirmed *yet* is not a payment that failed, and telling a customer it was would
             send them to pay twice. -->
        <div v-else-if="timedOut" class="mt-2">
          <SfAlert tone="info" :title="t('success.slowTitle')">{{ t('success.slowBody') }}</SfAlert>
        </div>

        <p v-else class="mt-2 flex items-center gap-2 text-text-secondary">
          <SfSpinner :label="t('success.pendingTitle')" size="sm" />
          {{ t('success.pendingBody') }}
        </p>

        <SfSkeleton v-if="booking === null && !timedOut" class="mt-4" :lines="3" />

        <dl v-else-if="booking !== null" class="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt class="text-text-secondary">{{ t('success.reference') }}</dt>
          <dd class="font-mono">{{ booking.reference }}</dd>

          <dt class="text-text-secondary">{{ t('booking.summaryService') }}</dt>
          <dd>{{ booking.serviceName }}</dd>

          <dt class="text-text-secondary">{{ t('booking.summaryEmployee') }}</dt>
          <dd>{{ booking.employeeDisplayName }}</dd>

          <dt class="text-text-secondary">{{ t('booking.summaryTime') }}</dt>
          <dd>{{ d(new Date(booking.startsAt), 'full') }}</dd>

          <dt class="text-text-secondary">{{ t('booking.summaryPrice') }}</dt>
          <dd>{{ money(booking.price) }}</dd>
        </dl>

        <p v-if="confirmed" class="mt-4 text-sm text-text-secondary">
          <!-- The management link is only in the email. It is a credential, and this page is
               reachable by anyone holding a session id. -->
          {{ t('success.manageHint') }}
        </p>
      </SfCard>

      <div>
        <WhatsAppButton
          :number="organization?.whatsappNumber ?? null"
          :reference="booking?.reference ?? null"
        />
      </div>
    </template>
  </div>
</template>
