<script setup lang="ts">
import { MAX_CALENDAR_RANGE_DAYS } from '@shape-and-flow/booking-contracts';
import {
  SfAlert,
  SfButton,
  SfCard,
  SfInput,
  SfSelect,
  SfSkeleton,
} from '@shape-and-flow/booking-ui';
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';

import { api } from '../../api/client.js';
import { useFocusStep } from '../../composables/useFocusStep.js';
import { addDays } from '../../composables/useLocalDate.js';
import { dateTime, localDateLabel, today } from '../../office/format.js';
import { registerOfficeMessages } from '../../office/i18n/index.js';
import { officeMessage } from '../../office/messages.js';
import { blockingBookingCount, useCrudResource } from '../../office/useCrudResource.js';
import { useSession } from '../../stores/session.js';

import type {
  BlockedTime,
  ClosedDay,
  OfficeEmployee,
  TimeOffEntry,
} from '@shape-and-flow/booking-contracts';

/**
 * The three ways time comes off the calendar.
 *
 * They are separate lists rather than one "unavailability" table because they are
 * separate things: **blocked time** is a span of instants for one person, **leave** is a
 * run of whole days for one person, and a **closure** is a day for everybody. Collapsing
 * them would mean asking what time somebody's holiday starts.
 *
 * An employee sees and edits only their own blocked time — §10.5 scopes
 * `availability.manage` to `own` for them — and the API answers 404 for anyone else's, so
 * the picker is limited rather than the refusal explained afterwards.
 */
registerOfficeMessages();

const session = useSession();
const { t } = useI18n();

useFocusStep('Availability');

// Derived from the contract rather than written as a number.
//
// This was `90`, while `blockedTimeListQuerySchema` and `closedDayListQuerySchema` both
// reject a span wider than MAX_CALENDAR_RANGE_DAYS — so every request this page made was a
// 400, and the page rendered empty lists on a working backend. A literal here and a limit
// there is a mismatch that no type checks, which is why the constant is imported instead.
//
// `inclusiveDaySpan` counts both endpoints, so the offset is one less than the limit.
const RANGE_DAYS = MAX_CALENDAR_RANGE_DAYS - 1;

const from = ref(today());
const to = computed(() => addDays(from.value, RANGE_DAYS));

const employees = ref<OfficeEmployee[]>([]);
const employeesError = ref<string | null>(null);

const blocked = useCrudResource<BlockedTime>(
  () => api.office.availability.blockedTimes({ from: from.value, to: to.value }),
  { immediate: false },
);

const timeOff = useCrudResource<TimeOffEntry>(() => api.office.availability.timeOff({}), {
  immediate: false,
});

const closedDays = useCrudResource<ClosedDay>(
  () => api.office.availability.closedDays({ from: from.value, to: to.value }),
  { immediate: false },
);

const employeeOptions = computed(() =>
  employees.value.map((employee) => ({ value: employee.id, label: employee.displayName })),
);

const blockForm = ref({ employeeId: '', date: today(), start: '13:00', end: '14:00', reason: '' });
const leaveForm = ref({ employeeId: '', startDate: today(), endDate: today(), reason: '' });
const closureForm = ref({ date: today(), reason: '' });

/**
 * A local date and wall clock as an instant.
 *
 * Built through `Date` in the browser's zone, which is the one place this screen cannot
 * avoid it: the operator types a Berlin wall clock and the API wants an instant. In
 * practice the office runs in the business's own zone; a note rather than a silent
 * assumption.
 */
function instantOf(date: string, wallClock: string): string {
  return new Date(`${date}T${wallClock}:00`).toISOString();
}

async function loadEmployees(): Promise<void> {
  employeesError.value = null;

  try {
    const response = await api.office.employees.list(false);
    employees.value = response.items;

    const own = session.employeeId;
    const first = response.items[0]?.id ?? '';

    blockForm.value.employeeId = own ?? first;
    leaveForm.value.employeeId = own ?? first;
  } catch (caught) {
    // Reported the way every other screen in this area reports a load failure. Rethrowing
    // out of `onMounted` would reject a promise nobody awaits, and the three lists below
    // would stay empty with no explanation on the page at all.
    employeesError.value = officeMessage(caught);
  }
}

async function reloadAll(): Promise<void> {
  await Promise.all([blocked.reload(), timeOff.reload(), closedDays.reload()]);
}

async function addBlock(): Promise<void> {
  const input = blockForm.value;
  if (input.employeeId === '') return;

  await blocked.save(() =>
    api.office.availability.createBlockedTime({
      employeeId: input.employeeId,
      startsAt: instantOf(input.date, input.start),
      endsAt: instantOf(input.date, input.end),
      ...(input.reason.trim() === '' ? {} : { reason: input.reason.trim() }),
    }),
  );
}

async function addLeave(): Promise<void> {
  const input = leaveForm.value;
  if (input.employeeId === '') return;

  await timeOff.save(() =>
    api.office.availability.createTimeOff({
      employeeId: input.employeeId,
      startDate: input.startDate,
      endDate: input.endDate,
      status: 'APPROVED',
      ...(input.reason.trim() === '' ? {} : { reason: input.reason.trim() }),
    }),
  );
}

async function addClosure(): Promise<void> {
  await closedDays.save(() =>
    api.office.availability.createClosedDay({
      date: closureForm.value.date,
      ...(closureForm.value.reason.trim() === ''
        ? {}
        : { reason: closureForm.value.reason.trim() }),
    }),
  );
}

const nameOf = (employeeId: string): string =>
  employees.value.find((employee) => employee.id === employeeId)?.displayName ?? employeeId;

onMounted(async () => {
  // Sequential, and the lists load whatever the employee call did: the picker needs the
  // names, but the three lists below do not, and a failed picker must not leave the whole
  // screen blank.
  await loadEmployees();
  await reloadAll();
});
</script>

<template>
  <section class="space-y-6">
    <h1 ref="heading" tabindex="-1" class="text-xl font-semibold tracking-tight outline-none">
      {{ t('office.availability.title') }}
    </h1>

    <p class="text-text-secondary">
      {{
        t('office.availability.rangeSummary', {
          from: localDateLabel(from),
          to: localDateLabel(to),
        })
      }}
    </p>

    <SfAlert v-if="employeesError !== null" tone="danger" data-test="employees-error">
      {{ employeesError }} {{ t('office.availability.employeesErrorNote') }}
    </SfAlert>

    <SfCard as="section" aria-labelledby="blocked-heading">
      <h2 id="blocked-heading" class="text-lg font-medium">
        {{ t('office.availability.blockedTitle') }}
      </h2>
      <p class="text-sm text-text-secondary">
        {{ t('office.availability.blockedDescription') }}
      </p>

      <SfAlert
        v-if="blocked.error.value !== null"
        tone="danger"
        class="mt-2"
        data-test="blocked-error"
      >
        {{ blocked.error.value }}
      </SfAlert>

      <div class="mt-3 grid gap-3 sm:grid-cols-5">
        <SfSelect
          :model-value="blockForm.employeeId"
          :label="t('office.availability.personLabel')"
          :options="employeeOptions"
          data-test="block-employee"
          @update:model-value="(value) => (blockForm.employeeId = value)"
        />
        <SfInput
          v-model="blockForm.date"
          type="date"
          :label="t('office.availability.dayLabel')"
          data-test="block-date"
        />
        <SfInput
          v-model="blockForm.start"
          type="time"
          :label="t('office.availability.fromLabel')"
          data-test="block-start"
        />
        <SfInput
          v-model="blockForm.end"
          type="time"
          :label="t('office.availability.toLabel')"
          data-test="block-end"
        />
        <SfInput
          v-model="blockForm.reason"
          :label="t('office.availability.reasonLabel')"
          data-test="block-reason"
        />
      </div>

      <SfButton
        class="mt-3"
        :loading="blocked.saving.value"
        data-test="add-block"
        @click="addBlock"
      >
        {{ t('office.availability.blockButton') }}
      </SfButton>

      <SfSkeleton v-if="blocked.loading.value" class="mt-3 h-16" />
      <ul v-else class="mt-3 space-y-1 text-sm">
        <li
          v-for="entry in blocked.items.value"
          :key="entry.id"
          class="flex flex-wrap items-center gap-2"
        >
          <span>{{ nameOf(entry.employeeId) }}</span>
          <span class="tabular-nums">{{ dateTime(entry.startsAt) }}</span>
          <span class="text-text-secondary">{{
            entry.reason ?? t('office.availability.blockedFallback')
          }}</span>
          <SfButton
            variant="ghost"
            class="ml-auto"
            :data-test="`remove-block-${entry.id}`"
            @click="blocked.save(() => api.office.availability.deleteBlockedTime(entry.id))"
          >
            {{ t('office.availability.removeButton') }}
          </SfButton>
        </li>
        <li v-if="blocked.items.value.length === 0" class="text-text-secondary">
          {{ t('office.availability.blockedEmpty') }}
        </li>
      </ul>
    </SfCard>

    <SfCard v-if="session.can('catalog.manage')" as="section" aria-labelledby="leave-heading">
      <h2 id="leave-heading" class="text-lg font-medium">
        {{ t('office.availability.leaveTitle') }}
      </h2>
      <p class="text-sm text-text-secondary">
        {{ t('office.availability.leaveDescription') }}
      </p>

      <SfAlert
        v-if="timeOff.error.value !== null"
        tone="danger"
        class="mt-2"
        data-test="leave-error"
      >
        {{ timeOff.error.value }}
        <template v-if="blockingBookingCount(timeOff.errorDetails.value) !== null">
          {{
            t('office.availability.leaveBlockedCount', {
              count: blockingBookingCount(timeOff.errorDetails.value),
            })
          }}
        </template>
      </SfAlert>

      <div class="mt-3 grid gap-3 sm:grid-cols-4">
        <SfSelect
          :model-value="leaveForm.employeeId"
          :label="t('office.availability.personLabel')"
          :options="employeeOptions"
          data-test="leave-employee"
          @update:model-value="(value) => (leaveForm.employeeId = value)"
        />
        <SfInput
          v-model="leaveForm.startDate"
          type="date"
          :label="t('office.availability.fromLabel')"
          data-test="leave-from"
        />
        <SfInput
          v-model="leaveForm.endDate"
          type="date"
          :label="t('office.availability.toLabel')"
          data-test="leave-to"
        />
        <SfInput
          v-model="leaveForm.reason"
          :label="t('office.availability.reasonLabel')"
          data-test="leave-reason"
        />
      </div>

      <SfButton
        class="mt-3"
        :loading="timeOff.saving.value"
        data-test="add-leave"
        @click="addLeave"
      >
        {{ t('office.availability.leaveButton') }}
      </SfButton>

      <ul class="mt-3 space-y-1 text-sm">
        <li v-for="entry in timeOff.items.value" :key="entry.id" class="flex flex-wrap gap-2">
          <span>{{ nameOf(entry.employeeId) }}</span>
          <span class="tabular-nums">
            {{ localDateLabel(entry.startDate) }}–{{ localDateLabel(entry.endDate) }}
          </span>
          <span class="text-text-secondary">{{ entry.status }}</span>
        </li>
        <li v-if="timeOff.items.value.length === 0" class="text-text-secondary">
          {{ t('office.availability.leaveEmpty') }}
        </li>
      </ul>
    </SfCard>

    <SfCard v-if="session.can('catalog.manage')" as="section" aria-labelledby="closures-heading">
      <h2 id="closures-heading" class="text-lg font-medium">
        {{ t('office.availability.closuresTitle') }}
      </h2>
      <p class="text-sm text-text-secondary">{{ t('office.availability.closuresDescription') }}</p>

      <SfAlert
        v-if="closedDays.error.value !== null"
        tone="danger"
        class="mt-2"
        data-test="closure-error"
      >
        {{ closedDays.error.value }}
      </SfAlert>

      <div class="mt-3 grid gap-3 sm:grid-cols-3">
        <SfInput
          v-model="closureForm.date"
          type="date"
          :label="t('office.availability.dayLabel')"
          data-test="closure-date"
        />
        <SfInput
          v-model="closureForm.reason"
          :label="t('office.availability.reasonLabel')"
          data-test="closure-reason"
        />
      </div>

      <SfButton
        class="mt-3"
        :loading="closedDays.saving.value"
        data-test="add-closure"
        @click="addClosure"
      >
        {{ t('office.availability.closeButton') }}
      </SfButton>

      <ul class="mt-3 space-y-1 text-sm">
        <li v-for="day in closedDays.items.value" :key="day.id" class="flex flex-wrap gap-2">
          <span class="tabular-nums">{{ localDateLabel(day.date) }}</span>
          <span class="text-text-secondary">{{
            day.reason ?? t('office.availability.closedFallback')
          }}</span>
          <SfButton
            variant="ghost"
            class="ml-auto"
            :data-test="`remove-closure-${day.id}`"
            @click="closedDays.save(() => api.office.availability.deleteClosedDay(day.id))"
          >
            {{ t('office.availability.reopenButton') }}
          </SfButton>
        </li>
        <li v-if="closedDays.items.value.length === 0" class="text-text-secondary">
          {{ t('office.availability.closedEmpty') }}
        </li>
      </ul>
    </SfCard>
  </section>
</template>
