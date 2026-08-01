<script setup lang="ts">
import { SfButton, SfCard, SfIcon } from '@shape-and-flow/booking-ui';
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';

import { api } from '../../api/client.js';

import type { OrganizationCurrentResponse } from '@shape-and-flow/booking-contracts';

const { t } = useI18n();
const router = useRouter();

const organization = ref<OrganizationCurrentResponse | null>(null);

/**
 * The cancellation window is read from the organization, not hard-coded into the copy.
 *
 * The business can change it in settings, and a landing page promising 24 hours while the API
 * enforces 48 is worse than saying nothing.
 */
onMounted(async () => {
  try {
    organization.value = await api.public.organization();
  } catch {
    // The page is still useful without it; the sentence that needs the number is hidden.
    organization.value = null;
  }
});
</script>

<template>
  <SfCard as="section">
    <h1 class="text-2xl font-semibold tracking-tight">{{ t('home.title') }}</h1>
    <p class="mt-2 text-text-secondary">{{ t('home.intro') }}</p>

    <ul class="mt-4 flex flex-col gap-2 text-sm text-text-secondary">
      <li class="flex items-center gap-2">
        <SfIcon name="calendar" /><span>{{ t('home.featureRealtime') }}</span>
      </li>
      <li class="flex items-center gap-2">
        <SfIcon name="credit-card" /><span>{{ t('home.featurePayment') }}</span>
      </li>
      <li v-if="organization !== null" class="flex items-center gap-2">
        <SfIcon name="clock" />
        <span>
          {{ t('home.featureCancellation', { hours: organization.freeCancellationHours }) }}
        </span>
      </li>
    </ul>

    <div class="mt-6">
      <SfButton @click="router.push({ name: 'booking-service' })">{{ t('home.start') }}</SfButton>
    </div>
  </SfCard>
</template>
