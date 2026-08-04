<script setup lang="ts">
import { SfButton } from '@shape-and-flow/booking-ui';
import { onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';

import { api } from '../../api/client.js';
import SlotPicker from '../../components/SlotPicker.vue';
import { useAsyncData } from '../../composables/useAsyncData.js';
import { useFocusStep } from '../../composables/useFocusStep.js';
import { addMonths, endOfMonth, localDate, startOfMonth } from '../../composables/useLocalDate.js';
import { useBookingDraft } from '../../stores/booking-draft.js';

const { t } = useI18n();
const router = useRouter();
const draft = useBookingDraft();
useFocusStep(t('booking.stepSlot'));

// The reader's actual now, in the business timezone. The injected-Clock rule exists for the API,
// where tests control time; a booking page has to start from the real today or it offers slots in
// the past.
// eslint-disable-next-line no-restricted-syntax -- see above
const today = localDate(new Date());
const monthAnchor = ref(startOfMonth(today));
const selectedDate = ref(today);

/** Never asks for a day before today, even when the displayed month starts earlier. */
function clampToToday(date: string): string {
  return date < today ? today : date;
}

const { data, errorKey, loading, run } = useAsyncData((signal) =>
  api.public.availability(
    {
      serviceId: draft.serviceId ?? '',
      ...(draft.employeeId === null ? {} : { employeeId: draft.employeeId }),
      from: clampToToday(monthAnchor.value),
      to: endOfMonth(monthAnchor.value),
    },
    signal,
  ),
);

onMounted(run);
watch(monthAnchor, run);

// The selected day defaults to today, or to the month's start after paging — but a day with
// nothing free is a poor first impression when a later one has something, so freshly loaded
// data jumps to the first day that does. A day the reader picked deliberately is left alone:
// this only runs when `data` itself changes, not when `selectedDate` does.
watch(data, (value) => {
  if (value === null) return;

  const selectedHasSlots = value.days.some(
    (day) => day.date === selectedDate.value && day.slots.length > 0,
  );
  if (selectedHasSlots) return;

  const firstWithSlots = value.days.find((day) => day.slots.length > 0);
  if (firstWithSlots !== undefined) selectedDate.value = firstWithSlots.date;
});

function select(startsAt: Date): void {
  draft.setSlot(startsAt);
  void router.push({ name: 'booking-details' });
}

function goToMonth(months: number): void {
  monthAnchor.value = addMonths(monthAnchor.value, months);
  selectedDate.value = clampToToday(monthAnchor.value);
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <h1 ref="heading" tabindex="-1" class="text-xl font-semibold tracking-tight outline-none">
      {{ t('booking.slotTitle') }}
    </h1>

    <SlotPicker
      :availability="data"
      :loading="loading"
      :error-key="errorKey"
      :selected="draft.slot"
      :month-anchor="monthAnchor"
      :selected-date="selectedDate"
      :today="today"
      :can-go-back="monthAnchor > startOfMonth(today)"
      @select="select"
      @select-date="selectedDate = $event"
      @previous-month="goToMonth(-1)"
      @next-month="goToMonth(1)"
      @jump-to="selectedDate = $event"
      @retry="run"
    />

    <div>
      <SfButton variant="ghost" @click="router.push({ name: 'booking-employee' })">
        {{ t('common.back') }}
      </SfButton>
    </div>
  </div>
</template>
