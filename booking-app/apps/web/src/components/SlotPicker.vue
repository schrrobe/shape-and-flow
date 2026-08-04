<script setup lang="ts">
import { SfAlert, SfButton, SfSkeleton } from '@shape-and-flow/booking-ui';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import SlotCalendar from './SlotCalendar.vue';

import type { AvailabilityResponse } from '@shape-and-flow/booking-contracts';

/**
 * The month calendar and the slot buttons for whichever day it has selected.
 *
 * Split from the calendar itself because picking a date is one question and picking a time is
 * another — the calendar only ever emits a date, this component owns turning that date into the
 * list of times underneath it.
 */
const props = defineProps<{
  availability: AvailabilityResponse | null;
  loading: boolean;
  errorKey: string | null;
  selected: Date | null;
  monthAnchor: string;
  selectedDate: string;
  today: string;
  /** False when the displayed month already contains today. */
  canGoBack: boolean;
}>();

const emit = defineEmits<{
  select: [Date];
  selectDate: [string];
  previousMonth: [];
  nextMonth: [];
  retry: [];
  jumpTo: [string];
}>();

const { t, d } = useI18n();

const days = computed(() => props.availability?.days ?? []);

const totalSlots = computed(() => days.value.reduce((count, day) => count + day.slots.length, 0));

/** The first day in the loaded month that has something, for the "next free day" affordance. */
const firstDayWithSlots = computed(() => days.value.find((day) => day.slots.length > 0) ?? null);

const selectedDaySlots = computed(
  () => days.value.find((day) => day.date === props.selectedDate)?.slots ?? [],
);

function isSelected(startsAt: string): boolean {
  return props.selected !== null && props.selected.getTime() === new Date(startsAt).getTime();
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <SlotCalendar
      :month-anchor="monthAnchor"
      :days="days"
      :today="today"
      :selected-date="selectedDate"
      :can-go-back="canGoBack"
      :loading="loading"
      @select="emit('selectDate', $event)"
      @previous-month="emit('previousMonth')"
      @next-month="emit('nextMonth')"
    />

    <SfSkeleton v-if="loading" :lines="4" />

    <SfAlert v-else-if="errorKey !== null" tone="danger" :title="t('errors.title')">
      {{ t(errorKey) }}
      <div class="mt-3">
        <SfButton variant="secondary" @click="emit('retry')">{{ t('common.retry') }}</SfButton>
      </div>
    </SfAlert>

    <SfAlert v-else-if="totalSlots === 0" tone="info" data-test="no-slots">
      {{ t('booking.slotNoneInRange') }}
    </SfAlert>

    <section v-else data-test="day" :data-date="selectedDate">
      <p v-if="selectedDaySlots.length === 0" class="text-sm text-text-secondary">
        {{ t('booking.slotEmptyDay') }}
        <button
          v-if="firstDayWithSlots !== null && firstDayWithSlots.date !== selectedDate"
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

      <ul v-else class="flex flex-wrap gap-2">
        <li v-for="slot in selectedDaySlots" :key="slot.startsAt">
          <button
            type="button"
            data-test="slot"
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
</template>
