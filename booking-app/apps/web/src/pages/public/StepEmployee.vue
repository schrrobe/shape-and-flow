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
useFocusStep(t('booking.stepEmployee'));

const { data, errorKey, loading, run } = useAsyncData((signal) =>
  api.public.employeesFor(draft.serviceId ?? '', signal),
);

onMounted(run);

const employees = computed(() => data.value?.items ?? []);

/**
 * "Anyone" is offered only when there is a choice to skip.
 *
 * With a single employee it is not a preference, it is the same person under two labels — and two
 * buttons that do the same thing make a customer wonder which one is right.
 */
const offerAny = computed(() => employees.value.length > 1);

function choose(employeeId: string | null, displayName: string | null = null): void {
  draft.setEmployee(employeeId, displayName);
  void router.push({ name: 'booking-slot' });
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <h1 ref="heading" tabindex="-1" class="text-xl font-semibold tracking-tight outline-none">
      {{ t('booking.employeeTitle') }}
    </h1>

    <SfSkeleton v-if="loading" :lines="3" />

    <SfAlert v-else-if="errorKey !== null" tone="danger" :title="t('errors.title')">
      {{ t(errorKey) }}
      <div class="mt-3">
        <SfButton variant="secondary" @click="run">{{ t('common.retry') }}</SfButton>
      </div>
    </SfAlert>

    <ul v-else class="flex flex-col gap-2">
      <SfCard v-if="offerAny" as="li" :padded="false">
        <button
          type="button"
          class="w-full rounded-sf p-4 text-left hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          @click="choose(null)"
        >
          <span class="block font-medium">{{ t('booking.employeeAny') }}</span>
          <span class="block text-sm text-text-secondary">{{ t('booking.employeeAnyHint') }}</span>
        </button>
      </SfCard>

      <SfCard v-for="employee in employees" :key="employee.id" as="li" :padded="false">
        <button
          type="button"
          class="flex w-full items-baseline justify-between gap-4 rounded-sf p-4 text-left hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          @click="choose(employee.id, employee.displayName)"
        >
          <span class="min-w-0">
            <span class="block font-medium">{{ employee.displayName }}</span>
            <span v-if="employee.bio !== null" class="block text-sm text-text-secondary">
              {{ employee.bio }}
            </span>
          </span>
          <span class="shrink-0 font-semibold">{{ money(employee.price) }}</span>
        </button>
      </SfCard>
    </ul>

    <div>
      <SfButton variant="ghost" @click="router.push({ name: 'booking-service' })">
        {{ t('common.back') }}
      </SfButton>
    </div>
  </div>
</template>
