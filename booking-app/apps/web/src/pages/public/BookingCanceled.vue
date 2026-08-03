<script setup lang="ts">
import { SfAlert, SfButton, SfCard } from '@shape-and-flow/booking-ui';
import { onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';

import { api } from '../../api/client.js';
import WhatsAppButton from '../../components/WhatsAppButton.vue';
import { useAsyncData } from '../../composables/useAsyncData.js';
import { useFocusStep } from '../../composables/useFocusStep.js';
import { useBookingDraft } from '../../stores/booking-draft.js';

const { t } = useI18n();
const router = useRouter();
const draft = useBookingDraft();
useFocusStep(t('canceled.title'));

const { data: organization, run } = useAsyncData((signal) => api.public.organization(signal));

onMounted(run);

/**
 * Start over with a new key.
 *
 * The abandoned attempt's key is spent as far as the customer's next decision is concerned: they
 * are choosing again, and reusing the key would replay the old payload.
 */
function restart(): void {
  draft.reset();
  draft.begin();
  void router.push({ name: 'booking-service' });
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <SfCard as="section">
      <h1 ref="heading" tabindex="-1" class="text-xl font-semibold tracking-tight outline-none">
        {{ t('canceled.title') }}
      </h1>

      <!-- Stated plainly and first. Somebody who backed out of a payment page wants to know
           whether they were charged before anything else. -->
      <SfAlert tone="info" class="mt-3">{{ t('canceled.body') }}</SfAlert>

      <div class="mt-5 flex flex-wrap gap-2">
        <SfButton @click="restart">{{ t('canceled.restart') }}</SfButton>
        <WhatsAppButton :number="organization?.whatsappNumber ?? null" />
      </div>
    </SfCard>
  </div>
</template>
