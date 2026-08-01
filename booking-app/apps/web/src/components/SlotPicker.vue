<script setup lang="ts">
import { SfAlert, SfButton, SfSkeleton } from '@shape-and-flow/booking-ui';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import type { AvailabilityResponse } from '@shape-and-flow/booking-contracts';

/**
 * The week strip and the slot buttons.
 *
 * Grouped by day rather than presented as one long list, because that is how somebody thinks
 * about an appointment: first which day, then what time. A day with nothing free says so instead
 * of vanishing — a missing Wednesday reads as a loading bug, while an empty Wednesday reads as a
 * full Wednesday.
 */
const props = defineProps<{
  availability: AvailabilityResponse | null;
  loading: boolean;
  errorKey: string | null;
  selected: Date | null;
  /** False when the range already starts today: there is no earlier week to show. */
  canGoBack: boolean;
}>();

const emit = defineEmits<{
  select: [Date];
  previousWeek: [];
  nextWeek: [];
  retry: [];
  jumpTo: [string];
}>();

const { t, d } = useI18n();

const days = computed(() => props.availability?.days ?? []);

const totalSlots = computed(() => days.value.reduce((count, day) => count + day.slots.length, 0));

/** The first day in the loaded range that has something, for the "next free day" affordance. */
const firstDayWithSlots = computed(() => days.value.find((day) => day.slots.length > 0) ?? null);

function isSelected(startsAt: string): boolean {
  return props.selected !== null && props.selected.getTime() === new Date(startsAt).getTime();
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex items-center justify-between gap-2">
      <SfButton variant="secondary" :disabled="!canGoBack" @click="emit('previousWeek')">
        {{ t('booking.slotWeekPrevious') }}
      </SfButton>
      <SfButton variant="secondary" @click="emit('nextWeek')">
        {{ t('booking.slotWeekNext') }}
      </SfButton>
    </div>

    <SfSkeleton v-if="loading" :lines="6" />

    <SfAlert v-else-if="errorKey !== null" tone="danger" :title="t('errors.title')">
      {{ t(errorKey) }}
      <div class="mt-3">
        <SfButton variant="secondary" @click="emit('retry')">{{ t('common.retry') }}</SfButton>
      </div>
    </SfAlert>

    <SfAlert v-else-if="totalSlots === 0" tone="info">
      {{ t('booking.slotNoneInRange') }}
    </SfAlert>

    <div v-else class="flex flex-col gap-4">
      <section v-for="day in days" :key="day.date">
        <h2 class="text-sm font-semibold text-text-primary">
          <!-- Berlin local, from the response's own timezone. A customer booking from abroad must
               see the clock on the wall at the address they are coming to. -->
          {{ d(new Date(`${day.date}T12:00:00Z`), 'dayMonth') }}
        </h2>

        <p v-if="day.slots.length === 0" class="mt-1 text-sm text-text-secondary">
          {{ t('booking.slotEmptyDay') }}
          <button
            v-if="firstDayWithSlots !== null && firstDayWithSlots.date !== day.date"
            type="button"
            class="rounded-sf underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            @click="emit('jumpTo', firstDayWithSlots.date)"
          >
            {{
              t('booking.slotNextAvailable', {
                date: d(new Date(`${firstDayWithSlots.date}T12:00:00Z`), 'dayMonth'),
              })
            }}
          </button>
        </p>

        <ul v-else class="mt-2 flex flex-wrap gap-2">
          <li v-for="slot in day.slots" :key="slot.startsAt">
            <button
              type="button"
              :aria-pressed="isSelected(slot.startsAt) ? 'true' : 'false'"
              class="rounded-sf border px-3 py-2 font-mono tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              :class="
                isSelected(slot.startsAt)
                  ? 'border-primary bg-primary text-primary-contrast'
                  : 'border-border bg-surface hover:bg-surface-muted'
              "
              @click="emit('select', new Date(slot.startsAt))"
            >
              {{ d(new Date(slot.startsAt), 'time') }}
            </button>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>
