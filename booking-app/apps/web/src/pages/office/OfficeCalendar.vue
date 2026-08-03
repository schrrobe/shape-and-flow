<script setup lang="ts">
import { localDateSchema } from '@shape-and-flow/booking-contracts';
import { SfAlert, SfButton, SfSelect, SfSkeleton } from '@shape-and-flow/booking-ui';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { api } from '../../api/client.js';
import CalendarGrid from '../../components/office/CalendarGrid.vue';
import { useAsyncData } from '../../composables/useAsyncData.js';
import { useFocusStep } from '../../composables/useFocusStep.js';
import { localDateLabel, today } from '../../office/format.js';
import { officeMessage } from '../../office/messages.js';
import { useSession } from '../../stores/session.js';

/**
 * The screen the office works from all day.
 *
 * The date lives in the URL, so a day is shareable and the back button moves between
 * days. The employee filter does too — an operator narrowing to one person and sending
 * the link to them expects them to land on the same view.
 *
 * A calendar is a **bounded range, never a page**: the API refuses more than 62 days, and
 * this asks for one day at a time because that is what the grid draws.
 */
const route = useRoute();
const router = useRouter();
const session = useSession();

useFocusStep('Calendar');

/**
 * The day on screen, and it has to be a real one.
 *
 * `?date=` is hand-editable and survives a bookmark, so it is input rather than state.
 * Anything that is not a `YYYY-MM-DD` calendar date falls back to today — without this,
 * `shift()` calls `toISOString()` on an `Invalid Date` and the screen throws instead of
 * showing the day the operator asked for.
 */
const date = computed(() => {
  const parsed = localDateSchema.safeParse(route.query.date);

  return parsed.success ? parsed.data : today();
});

const employeeFilter = computed(() =>
  typeof route.query.employeeId === 'string' ? route.query.employeeId : '',
);

const employees = ref<{ id: string; displayName: string }[]>([]);
const employeesError = ref<string | null>(null);

const { data, errorKey, loading, run } = useAsyncData((signal) =>
  api.office.calendar(
    {
      from: date.value,
      to: date.value,
      ...(employeeFilter.value === '' ? {} : { employeeId: employeeFilter.value }),
    },
    signal,
  ),
);

/**
 * The columns to draw.
 *
 * From the employee list rather than from the bookings: a person with nothing booked
 * still has a column, which is the column an operator is looking for when they want to
 * put something in it.
 */
const employeeOptions = computed(() => [
  { value: '', label: 'Everyone' },
  ...employees.value.map((employee) => ({ value: employee.id, label: employee.displayName })),
]);

const columns = computed(() => {
  if (employeeFilter.value !== '') {
    return employees.value.filter((employee) => employee.id === employeeFilter.value);
  }
  return employees.value;
});

async function loadEmployees(): Promise<void> {
  try {
    const response = await api.office.employees.list(false);
    employees.value = response.items.map((employee) => ({
      id: employee.id,
      displayName: employee.displayName,
    }));
  } catch (error) {
    // Non-fatal: without the list there are no columns, but the message says why rather
    // than leaving an empty grid that looks like a quiet day.
    employeesError.value = officeMessage(error);
  }
}

function goTo(next: Partial<{ date: string; employeeId: string }>): void {
  void router.replace({
    query: {
      ...route.query,
      ...(next.date === undefined ? {} : { date: next.date }),
      ...(next.employeeId === undefined
        ? {}
        : { employeeId: next.employeeId === '' ? undefined : next.employeeId }),
    },
  });
}

function shift(days: number): void {
  const anchored = new Date(`${date.value}T12:00:00Z`);
  anchored.setUTCDate(anchored.getUTCDate() + days);
  goTo({ date: anchored.toISOString().slice(0, 10) });
}

onMounted(async () => {
  await loadEmployees();
  await run();
});

// Reload on every change of day or employee. `run` aborts the in-flight request, so
// clicking through a week does not paint Monday's answer over Thursday's.
watch([date, employeeFilter], run);
</script>

<template>
  <section class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h1 ref="heading" tabindex="-1" class="text-xl font-semibold tracking-tight outline-none">
        Calendar
      </h1>

      <div class="flex flex-wrap items-center gap-2">
        <SfButton variant="secondary" data-test="prev-day" @click="shift(-1)">Previous</SfButton>
        <p class="min-w-32 text-center font-medium tabular-nums" data-test="current-date">
          {{ localDateLabel(date) }}
        </p>
        <SfButton variant="secondary" data-test="next-day" @click="shift(1)">Next</SfButton>
        <SfButton variant="ghost" data-test="today" @click="goTo({ date: today() })">
          Today
        </SfButton>
      </div>
    </div>

    <!--
      Hidden for an employee: §10.5 gives them `calendar.viewAll: none`, so the only
      column they can see is their own and a filter offering others would be a control
      that answers 404.
    -->
    <SfSelect
      v-if="session.can('calendar.viewAll')"
      label="Person"
      :model-value="employeeFilter"
      :options="employeeOptions"
      data-test="employee-filter"
      @update:model-value="(value) => goTo({ employeeId: value })"
    />

    <SfAlert v-if="employeesError !== null" tone="warning">{{ employeesError }}</SfAlert>
    <SfAlert v-if="errorKey !== null" tone="danger" data-test="error">
      {{ officeMessage(errorKey) }}
    </SfAlert>

    <SfSkeleton v-if="loading && data === null" class="h-96" />

    <CalendarGrid
      v-else-if="data !== null"
      :date="date"
      :employees="columns"
      :calendar="data"
      @change-date="(next) => goTo({ date: next })"
      @select="(id) => router.push({ name: 'office-booking', params: { id } })"
    />
  </section>
</template>
