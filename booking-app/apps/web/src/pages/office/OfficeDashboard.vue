<script setup lang="ts">
import { SfAlert, SfCard, SfSkeleton } from '@shape-and-flow/booking-ui';
import { computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';

import { api } from '../../api/client.js';
import StatusBadge from '../../components/office/StatusBadge.vue';
import { useAsyncData } from '../../composables/useAsyncData.js';
import { useFocusStep } from '../../composables/useFocusStep.js';
import { money, time } from '../../office/format.js';
import { registerOfficeMessages } from '../../office/i18n/index.js';
import { officeMessage } from '../../office/messages.js';

registerOfficeMessages();

/**
 * The morning screen.
 *
 * Every tile links to the list it counts, because a number an operator cannot open is a
 * number they have to go and look for. The operations panel is the exception: it is
 * **visually quiet when everything is zero**, which is most days — a permanently loud
 * diagnostics block is one nobody reads on the day it matters.
 */
const { data, errorKey, loading, run } = useAsyncData((signal) => api.office.dashboard(signal));
const { t } = useI18n();

useFocusStep(() => t('office.dashboard.heading'));
onMounted(run);

/** The operations figures, with `-1` meaning "could not be counted". */
const operations = computed(() => {
  const health = data.value?.operations;
  if (health === undefined) return [];

  return [
    {
      id: 'failed-jobs',
      label: t('office.dashboard.operations.failedJobs'),
      value: health.failedJobs,
      to: null,
    },
    {
      id: 'stuck-outbox-rows',
      label: t('office.dashboard.operations.stuckOutboxRows'),
      value: health.stuckOutboxRows,
      to: null,
    },
    {
      id: 'pending-notifications',
      label: t('office.dashboard.operations.pendingNotifications'),
      value: health.pendingNotifications,
      to: null,
    },
    {
      id: 'unprocessed-webhooks',
      label: t('office.dashboard.operations.unprocessedWebhooks'),
      value: health.unprocessedWebhooks,
      to: null,
    },
    {
      id: 'overdue-completions',
      label: t('office.dashboard.operations.overdueCompletions'),
      value: health.overdueCompletions,
      to: null,
    },
  ];
});

/** True when nothing is wrong and nothing is unknown, which is when to stay quiet. */
const operationsQuiet = computed(() => operations.value.every((row) => row.value === 0));
</script>

<template>
  <section class="space-y-4">
    <h1 ref="heading" tabindex="-1" class="text-xl font-semibold tracking-tight outline-none">
      {{ t('office.dashboard.heading') }}
    </h1>

    <SfAlert v-if="errorKey !== null" tone="danger" data-test="error">
      {{ officeMessage(errorKey) }}
    </SfAlert>

    <div v-if="loading && data === null" class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <SfSkeleton v-for="index in 4" :key="index" class="h-20" />
    </div>

    <template v-else-if="data !== null">
      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <RouterLink
          :to="{ name: 'office-bookings', query: { from: 'today', to: 'today' } }"
          class="rounded-sf border border-border bg-surface p-4 hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          data-test="tile-today"
        >
          <p class="text-sm text-text-secondary">{{ t('office.dashboard.today') }}</p>
          <p class="text-2xl font-semibold">{{ data.today.length }}</p>
        </RouterLink>

        <RouterLink
          :to="{ name: 'office-bookings', query: { status: 'CONFIRMED' } }"
          class="rounded-sf border border-border bg-surface p-4 hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          data-test="tile-next7"
        >
          <p class="text-sm text-text-secondary">{{ t('office.dashboard.nextSevenDays') }}</p>
          <p class="text-2xl font-semibold">{{ data.next7DaysCount }}</p>
        </RouterLink>

        <RouterLink
          :to="{ name: 'office-requests' }"
          class="rounded-sf border border-border bg-surface p-4 hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          data-test="tile-requests"
        >
          <p class="text-sm text-text-secondary">{{ t('office.dashboard.openRequests') }}</p>
          <p class="text-2xl font-semibold">
            {{ data.pendingCancellationRequests + data.pendingRescheduleRequests }}
          </p>
          <p class="text-xs text-text-secondary">
            {{
              t('office.dashboard.requestsBreakdown', {
                cancel: data.pendingCancellationRequests,
                move: data.pendingRescheduleRequests,
              })
            }}
          </p>
        </RouterLink>

        <div class="rounded-sf border border-border bg-surface p-4" data-test="tile-revenue">
          <p class="text-sm text-text-secondary">{{ t('office.dashboard.takenToday') }}</p>
          <p class="text-2xl font-semibold">{{ money(data.todayRevenue) }}</p>
          <p class="text-xs text-text-secondary">
            {{ t('office.dashboard.stillToPay', { count: data.unpaidConfirmedBookings }) }}
          </p>
        </div>
      </div>

      <SfCard as="section" aria-labelledby="today-heading">
        <h2 id="today-heading" class="text-lg font-medium">{{ t('office.dashboard.today') }}</h2>

        <p v-if="data.today.length === 0" class="mt-2 text-text-secondary" data-test="today-empty">
          {{ t('office.dashboard.nothingBookedToday') }}
        </p>

        <ul v-else class="mt-3 divide-y divide-border">
          <li v-for="appointment in data.today" :key="appointment.id" class="py-2">
            <RouterLink
              :to="{ name: 'office-booking', params: { id: appointment.id } }"
              class="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-sf hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              <span class="font-medium tabular-nums">{{ time(appointment.startsAt) }}</span>
              <span>{{ appointment.customerName }}</span>
              <span class="text-text-secondary">{{ appointment.serviceName }}</span>
              <span class="text-text-secondary">{{ appointment.employeeName }}</span>
              <StatusBadge :status="appointment.displayStatus" class="ml-auto" />
            </RouterLink>
          </li>
        </ul>
      </SfCard>

      <!--
        Quiet when everything is zero. A diagnostics block that shouts every day is one
        nobody looks at on the day it has something to say.
      -->
      <section
        class="rounded-sf border p-4"
        :class="operationsQuiet ? 'border-border bg-surface' : 'border-warning bg-warning/10'"
        data-test="operations"
        :data-quiet="operationsQuiet"
        aria-labelledby="operations-heading"
      >
        <h2 id="operations-heading" class="text-sm font-medium text-text-secondary">
          {{ t('office.dashboard.operationsHeading') }}
        </h2>

        <dl class="mt-2 flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <div v-for="row in operations" :key="row.id" class="flex items-baseline gap-2">
            <dt class="text-text-secondary">{{ row.label }}</dt>
            <dd class="font-medium tabular-nums" :data-test="`ops-${row.id}`">
              <!-- `-1` is the API saying it could not read the figure, not a count. -->
              {{ row.value < 0 ? t('office.dashboard.operations.unknown') : row.value }}
            </dd>
          </div>
        </dl>
      </section>
    </template>
  </section>
</template>
