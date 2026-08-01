<script setup lang="ts">
import { SfAlert, SfButton, SfCard, SfSkeleton } from '@shape-and-flow/booking-ui';
import { computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';

import { api } from '../../api/client.js';
import { useAsyncData } from '../../composables/useAsyncData.js';
import { useFocusStep } from '../../composables/useFocusStep.js';
import { useMoney } from '../../i18n/money.js';
import { useBookingDraft } from '../../stores/booking-draft.js';

const { t } = useI18n();
const { money } = useMoney();
const router = useRouter();
const draft = useBookingDraft();
useFocusStep(t('booking.stepService'));

const { data, errorKey, loading, run } = useAsyncData((signal) =>
  api.public.serviceCategories(signal),
);

onMounted(run);

/** Categories with nothing bookable in them are noise on a booking page. */
const categories = computed(() => (data.value?.items ?? []).filter((c) => c.services.length > 0));

const empty = computed(
  () => !loading.value && errorKey.value === null && categories.value.length === 0,
);

function choose(service: { id: string; name: string; price: { amountCents: number } }): void {
  draft.setService(service.id, { name: service.name, priceCents: service.price.amountCents });
  void router.push({ name: 'booking-employee' });
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <h1 ref="heading" tabindex="-1" class="text-xl font-semibold tracking-tight outline-none">
      {{ t('booking.serviceTitle') }}
    </h1>

    <SfSkeleton v-if="loading" :lines="4" />

    <SfAlert v-else-if="errorKey !== null" tone="danger" :title="t('errors.title')">
      {{ t(errorKey) }}
      <div class="mt-3">
        <SfButton variant="secondary" @click="run">{{ t('common.retry') }}</SfButton>
      </div>
    </SfAlert>

    <SfAlert v-else-if="empty" tone="info">{{ t('booking.serviceEmpty') }}</SfAlert>

    <div v-else class="flex flex-col gap-5">
      <section v-for="category in categories" :key="category.id">
        <h2 class="text-sm font-semibold uppercase tracking-wide text-text-secondary">
          {{ category.name }}
        </h2>

        <ul class="mt-2 flex flex-col gap-2">
          <SfCard v-for="service in category.services" :key="service.id" as="li" :padded="false">
            <button
              type="button"
              class="flex w-full items-baseline justify-between gap-4 rounded-sf p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring hover:bg-surface-muted"
              @click="choose(service)"
            >
              <span class="min-w-0">
                <span class="block font-medium">{{ service.name }}</span>
                <span v-if="service.description !== null" class="block text-sm text-text-secondary">
                  {{ service.description }}
                </span>
                <span class="block text-sm text-text-secondary">
                  {{ t('common.minutes', { count: service.durationMinutes }) }}
                </span>
              </span>
              <span class="shrink-0 font-semibold">
                {{ money(service.price) }}
              </span>
            </button>
          </SfCard>
        </ul>
      </section>
    </div>
  </div>
</template>
