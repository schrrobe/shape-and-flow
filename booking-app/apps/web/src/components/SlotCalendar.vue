<script setup lang="ts">
import { SfButton } from '@shape-and-flow/booking-ui';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import { addDays } from '../composables/useLocalDate.js';
import { DISPLAY_ZONE } from '../i18n/index.js';

import type { AvailabilityResponse } from '@shape-and-flow/booking-contracts';

/**
 * The month grid. One tap picks a day; the time-of-day list lives beside it, not here.
 *
 * Only days within `monthAnchor`'s month get a cell — the surrounding blanks are just grid
 * filler, not adjacent-month days, so there is nothing there to click.
 */
const props = defineProps<{
  /** The first of the displayed month, `YYYY-MM-DD`. */
  monthAnchor: string;
  days: AvailabilityResponse['days'];
  /** `YYYY-MM-DD`, business timezone. A day before this cannot be selected. */
  today: string;
  selectedDate: string | null;
  /** False when the displayed month already contains today: there is no earlier month to show. */
  canGoBack: boolean;
  /** Whether `days` reflects the displayed month yet, or is still the previous fetch's data. */
  loading: boolean;
}>();

const emit = defineEmits<{
  select: [string];
  previousMonth: [];
  nextMonth: [];
}>();

const { t, d, locale } = useI18n();

const monthLabel = computed(() => d(new Date(`${props.monthAnchor}T12:00:00Z`), 'monthYear'));

/** 2024-01-01 was a Monday, and this only ever reads its weekday name. */
const weekdayLabels = computed(() => {
  const formatter = new Intl.DateTimeFormat(locale.value, {
    weekday: 'short',
    timeZone: DISPLAY_ZONE,
  });
  return Array.from({ length: 7 }, (_, index) =>
    formatter.format(new Date(Date.UTC(2024, 0, 1 + index))),
  );
});

/** Monday-first column count before the 1st of the month. */
const leadingBlanks = computed(() => {
  const first = new Date(`${props.monthAnchor}T12:00:00Z`);
  return (first.getUTCDay() + 6) % 7;
});

const cells = computed(() => {
  const first = new Date(`${props.monthAnchor}T12:00:00Z`);
  const daysInMonth = new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
  ).getUTCDate();
  const hasSlotsByDate = new Map(props.days.map((day) => [day.date, day.slots.length > 0]));
  const monthPrefix = props.monthAnchor.slice(0, 7);

  return Array.from({ length: daysInMonth }, (_, index) => {
    const dayOfMonth = index + 1;
    const date = `${monthPrefix}-${String(dayOfMonth).padStart(2, '0')}`;
    return {
      date,
      dayOfMonth,
      hasSlots: hasSlotsByDate.get(date) === true,
      disabled: date < props.today,
    };
  });
});

function cellLabel(date: string, hasSlots: boolean): string {
  const key = hasSlots ? 'booking.slotDayAvailable' : 'booking.slotDayUnavailable';
  return t(key, { date: d(new Date(`${date}T12:00:00Z`), 'dateLong') });
}

/**
 * Only one day cell sits in the tab sequence at a time — the arrow-key roving-tabindex pattern.
 * Thirty-one equally-focusable buttons would make reaching the time list a chore for anyone not
 * using a mouse.
 */
const rovingDate = computed(() => {
  const { selectedDate } = props;
  if (selectedDate !== null && selectedDate.slice(0, 7) === props.monthAnchor.slice(0, 7)) {
    return selectedDate;
  }
  return cells.value.find((cell) => !cell.disabled)?.date ?? cells.value[0]?.date ?? null;
});

const dayButtons = new Map<string, HTMLButtonElement>();

function registerDay(date: string, el: unknown): void {
  if (el instanceof HTMLButtonElement) {
    dayButtons.set(date, el);
  } else {
    dayButtons.delete(date);
  }
}

// A plain function, not an inline arrow, so the template's `:ref` binding has no `=>` in it —
// the copy-scanner strips tags by their first `>`, and an arrow function's own `>` closes that
// match early and leaks the rest of the tag as if it were literal text.
function dayRef(date: string): (el: unknown) => void {
  return (el) => {
    registerDay(date, el);
  };
}

const ARROW_DELTAS: Record<string, number> = {
  ArrowRight: 1,
  ArrowLeft: -1,
  ArrowDown: 7,
  ArrowUp: -7,
};

function onDayKeydown(event: KeyboardEvent, date: string): void {
  const delta = ARROW_DELTAS[event.key];
  if (delta === undefined) return;
  event.preventDefault();

  const target = addDays(date, delta);
  const cell = cells.value.find((candidate) => candidate.date === target);
  if (cell === undefined || cell.disabled) return;

  dayButtons.get(target)?.focus();
}
</script>

<template>
  <div class="flex flex-col gap-3" data-test="calendar" :data-loading="loading ? 'true' : 'false'">
    <div class="flex items-center justify-between">
      <SfButton
        variant="ghost"
        data-test="previous-month"
        :disabled="!canGoBack"
        :aria-label="t('booking.slotMonthPrevious')"
        @click="emit('previousMonth')"
      >
        <span aria-hidden="true">‹</span>
      </SfButton>

      <p data-test="calendar-month" :data-month="monthAnchor.slice(0, 7)" class="font-semibold">
        {{ monthLabel }}
      </p>

      <SfButton
        variant="ghost"
        data-test="next-month"
        :aria-label="t('booking.slotMonthNext')"
        @click="emit('nextMonth')"
      >
        <span aria-hidden="true">›</span>
      </SfButton>
    </div>

    <div class="grid grid-cols-7 gap-1 text-center text-xs text-text-secondary" aria-hidden="true">
      <span v-for="(label, index) in weekdayLabels" :key="index">{{ label }}</span>
    </div>

    <div class="grid grid-cols-7 gap-1">
      <div v-for="blank in leadingBlanks" :key="`blank-${blank}`" />

      <button
        v-for="cell in cells"
        :key="cell.date"
        :ref="dayRef(cell.date)"
        type="button"
        data-test="calendar-day"
        :data-date="cell.date"
        :data-has-slots="cell.hasSlots ? 'true' : 'false'"
        :disabled="cell.disabled"
        :tabindex="cell.date === rovingDate ? 0 : -1"
        :aria-pressed="cell.date === selectedDate ? 'true' : 'false'"
        :aria-label="cellLabel(cell.date, cell.hasSlots)"
        class="relative rounded-sf py-2 text-sm tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-40"
        :class="
          cell.date === selectedDate
            ? 'bg-primary text-primary-contrast'
            : 'bg-surface text-text-primary hover:bg-surface-muted'
        "
        @click="emit('select', cell.date)"
        @keydown="onDayKeydown($event, cell.date)"
      >
        {{ cell.dayOfMonth }}
        <span
          v-if="cell.hasSlots"
          class="absolute inset-x-0 bottom-1 mx-auto h-1 w-1 rounded-full"
          :class="cell.date === selectedDate ? 'bg-primary-contrast' : 'bg-primary'"
        />
      </button>
    </div>
  </div>
</template>
