<script setup lang="ts">
import { computed } from 'vue';

import { addDays } from '../../composables/useLocalDate.js';
import { i18n } from '../../i18n/index.js';
import { minuteOfDay, money, time } from '../../office/format.js';
import { registerOfficeMessages } from '../../office/i18n/index.js';

import {
  hasTimeOff,
  placeBlockedTimes,
  placeBooking,
  visibleRange,
  weekdayOf,
  workingBands,
} from './calendar-layout.js';
import StatusBadge from './StatusBadge.vue';

import type { OfficeCalendarResponse } from '@shape-and-flow/booking-contracts';

/**
 * One day, employees as columns.
 *
 * A CSS grid rather than absolute positioning: every band is placed by row start and row
 * span in minute units, which means the browser does the layout and there is no
 * `top: 312px` computed from a magic pixels-per-minute constant.
 *
 * The whole component positions by **Berlin-local minutes**, never by the browser's
 * clock. `calendar-layout.ts` says why, and `CalendarGrid.spec.ts` proves it by asserting
 * an appointment stored as `07:00Z` lands at `09:00`.
 */
const props = defineProps<{
  date: string;
  employees: { id: string; displayName: string }[];
  calendar: OfficeCalendarResponse;
}>();

const emit = defineEmits<{
  changeDate: [date: string];
  select: [bookingId: string];
}>();

registerOfficeMessages();

const gridAriaLabel = computed(() => i18n.global.t('office.calendarGrid.gridAriaLabel'));
const closedLabel = computed(() => i18n.global.t('office.calendarGrid.closed'));
const onLeaveLabel = computed(() => i18n.global.t('office.calendarGrid.onLeave'));
const blockedDefaultLabel = computed(() => i18n.global.t('office.calendarGrid.blockedDefault'));

const weekday = computed(() => weekdayOf(props.date));

const closedDay = computed(() => props.calendar.closedDays.find((day) => day.date === props.date));

/** One column per visible employee, with everything already placed. */
const columns = computed(() =>
  props.employees.map((employee) => ({
    employee,
    bands: workingBands(props.calendar, employee.id, weekday.value),
    blocked: placeBlockedTimes(props.calendar, employee.id, props.date),
    away: hasTimeOff(props.calendar, employee.id, props.date),
    bookings: props.calendar.bookings
      .filter((booking) => booking.employeeId === employee.id)
      .map((booking) => placeBooking(booking, props.date))
      .filter((placed) => placed.endMinute > placed.startMinute),
  })),
);

const range = computed(() =>
  visibleRange(
    columns.value.flatMap((column) => [
      ...column.bands,
      ...column.blocked,
      ...column.bookings.map((placed) => ({
        startMinute: placed.before?.startMinute ?? placed.startMinute,
        endMinute: placed.after?.endMinute ?? placed.endMinute,
      })),
    ]),
  ),
);

/** The hour labels down the left. */
const hours = computed(() => {
  const labels: number[] = [];
  for (let minute = range.value.from; minute <= range.value.to; minute += 60) labels.push(minute);
  return labels;
});

/** Grid rows are one minute each, so a band's position is its own arithmetic. */
function rowStyle(band: { startMinute: number; endMinute: number }): Record<string, string> {
  const from = Math.max(band.startMinute, range.value.from);
  const to = Math.min(band.endMinute, range.value.to);

  return {
    gridRowStart: String(from - range.value.from + 1),
    gridRowEnd: String(Math.max(to - from, 1) + (from - range.value.from) + 1),
  };
}

const gridStyle = computed(() => ({
  gridTemplateRows: `repeat(${String(range.value.to - range.value.from)}, minmax(0, 0.75px))`,
}));

function shiftDate(days: number): void {
  emit('changeDate', addDays(props.date, days));
}

/**
 * Arrow keys move between days.
 *
 * On the grid itself rather than on a button, because the grid is what an operator is
 * looking at — and it carries `tabindex="0"` so it can be reached without a mouse at all.
 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowRight') shiftDate(1);
  else if (event.key === 'ArrowLeft') shiftDate(-1);
  else return;

  event.preventDefault();
}
</script>

<template>
  <!-- The rule asks for an interactive role before an interactive handler.
       `group` is the honest role for a day of appointments, and the reachability
       the rule is protecting is already there: tabindex puts the grid in the tab
       order and the label says what the arrow keys do. -->
  <!-- eslint-disable-next-line vuejs-accessibility/no-static-element-interactions -->
  <div
    data-test="grid"
    tabindex="0"
    role="group"
    :aria-label="gridAriaLabel"
    class="rounded-sf border border-border bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
    @keydown="onKeydown"
  >
    <div
      v-if="closedDay !== undefined"
      data-test="closed"
      aria-disabled="true"
      class="border-b border-border bg-surface-muted px-3 py-2 text-sm text-text-secondary"
    >
      {{ closedLabel }}{{ closedDay.reason === null ? '' : ` — ${closedDay.reason}` }}
    </div>

    <div class="flex">
      <!-- The hour gutter. `aria-hidden`, because the times are already on every band. -->
      <div aria-hidden="true" class="w-12 shrink-0 border-r border-border pt-2">
        <div class="grid" :style="gridStyle">
          <div
            v-for="hour in hours"
            :key="hour"
            class="-mt-2 text-right text-xs text-text-secondary"
            :style="rowStyle({ startMinute: hour, endMinute: hour + 1 })"
          >
            {{ minuteOfDay(hour) }}
          </div>
        </div>
      </div>

      <div class="flex min-w-0 flex-1">
        <section
          v-for="column in columns"
          :key="column.employee.id"
          data-test="column"
          class="min-w-0 flex-1 border-r border-border last:border-r-0"
          :aria-label="column.employee.displayName"
        >
          <h3 class="truncate border-b border-border px-2 py-1 text-sm font-medium">
            {{ column.employee.displayName }}
          </h3>

          <div class="relative grid pt-2" :style="gridStyle">
            <!-- Working hours, as the lit part of the column. -->
            <div
              v-for="(band, index) in column.bands"
              :key="`band-${String(index)}`"
              data-test="working"
              class="col-start-1 row-start-1 rounded-sf bg-surface-muted/40"
              :style="rowStyle(band)"
            />

            <div
              v-if="column.away"
              data-test="timeoff"
              aria-disabled="true"
              class="col-start-1 row-start-1 flex items-start justify-center bg-surface-muted px-1 py-1 text-xs text-text-secondary"
              :style="rowStyle({ startMinute: range.from, endMinute: range.to })"
            >
              {{ onLeaveLabel }}
            </div>

            <div
              v-for="blocked in column.blocked"
              :key="blocked.id"
              data-test="blocked"
              aria-disabled="true"
              class="col-start-1 overflow-hidden rounded-sf border border-border bg-surface-muted px-1 text-xs text-text-secondary"
              :style="rowStyle(blocked)"
            >
              {{ blocked.reason ?? blockedDefaultLabel }}
            </div>

            <!-- Buffers first, so an appointment paints over its own band edges. -->
            <template v-for="placed in column.bookings" :key="placed.booking.id">
              <div
                v-if="placed.before !== null"
                data-test="buffer"
                aria-hidden="true"
                class="col-start-1 rounded-t-sf bg-border/60"
                :style="rowStyle(placed.before)"
              />
              <div
                v-if="placed.after !== null"
                data-test="buffer"
                aria-hidden="true"
                class="col-start-1 rounded-b-sf bg-border/60"
                :style="rowStyle(placed.after)"
              />
            </template>

            <button
              v-for="placed in column.bookings"
              :key="`booking-${placed.booking.id}`"
              type="button"
              data-test="slot"
              :data-local-start="minuteOfDay(placed.startMinute)"
              :data-booking-id="placed.booking.id"
              class="col-start-1 overflow-hidden rounded-sf border border-border bg-surface px-1 text-left text-xs hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              :style="rowStyle(placed)"
              @click="emit('select', placed.booking.id)"
            >
              <span class="block truncate font-medium">
                {{ time(placed.booking.startsAt) }} {{ placed.booking.customerName }}
              </span>
              <span class="block truncate text-text-secondary">
                {{ placed.booking.serviceName }} · {{ money(placed.booking.price) }}
              </span>
              <StatusBadge :status="placed.booking.displayStatus" compact class="mt-0.5" />
            </button>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>
