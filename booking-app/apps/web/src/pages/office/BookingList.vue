<script setup lang="ts">
import { bookingStatusSchema } from '@shape-and-flow/booking-contracts';
import { SfAlert, SfButton, SfInput, SfSelect, SfSkeleton } from '@shape-and-flow/booking-ui';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { api } from '../../api/client.js';
import StatusBadge from '../../components/office/StatusBadge.vue';
import { useFocusStep } from '../../composables/useFocusStep.js';
import { dateTime, money, today } from '../../office/format.js';
import { officeMessage } from '../../office/messages.js';

import type { OfficeBookingListItem } from '@shape-and-flow/booking-contracts';

/**
 * Bookings, filtered and paged.
 *
 * **Filter state lives in the URL**, which is what makes a view shareable — "the three
 * unpaid ones from last Tuesday" is a link, not a description. It also means the back
 * button undoes a filter rather than leaving the page.
 *
 * Paging is a "load more" button rather than numbered pages, because the cursor is
 * opaque and one-directional: there is no page 4 to jump to, and pretending otherwise
 * would mean an interface that cannot honour its own controls.
 */
const route = useRoute();
const router = useRouter();

useFocusStep('Bookings');

const statusOptions = [
  { value: '', label: 'Any status' },
  ...bookingStatusSchema.options.map((status) => ({ value: status, label: status })),
];

const SORT_OPTIONS = [
  { value: 'startsAt:desc', label: 'Latest appointment first' },
  { value: 'startsAt:asc', label: 'Earliest appointment first' },
  { value: 'createdAt:desc', label: 'Newest booking first' },
  { value: 'createdAt:asc', label: 'Oldest booking first' },
];

const items = ref<OfficeBookingListItem[]>([]);
const nextCursor = ref<string | null>(null);
const loading = ref(false);
const loadingMore = ref(false);
const error = ref<string | null>(null);

const queryString = (key: string): string =>
  typeof route.query[key] === 'string' ? route.query[key] : '';

const filters = computed(() => ({
  status: queryString('status'),
  q: queryString('q'),
  from: queryString('from'),
  to: queryString('to'),
  sort: queryString('sort') === '' ? 'startsAt:desc' : queryString('sort'),
}));

/** Local mirrors, so typing does not rewrite the URL on every keystroke. */
const search = ref(filters.value.q);
watch(filters, (next) => {
  search.value = next.q;
});

function apply(next: Record<string, string>): void {
  const merged = { ...(route.query as Record<string, string>), ...next };
  // Rebuilt rather than pruned in place: an empty filter must leave the URL entirely, or
  // a shared link carries `?status=` and reads as a filter that is set to nothing.
  const query = Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== ''));

  void router.replace({ query });
}

function requestQuery(cursor?: string) {
  const current = filters.value;

  return {
    limit: 25,
    sort: current.sort as 'startsAt:desc',
    ...(current.status === '' ? {} : { status: [current.status] as never }),
    ...(current.q === '' ? {} : { q: current.q }),
    // `today` is a shorthand the dashboard tiles link with, resolved here rather than in
    // the URL so a bookmark taken today still means today next week.
    ...(current.from === '' ? {} : { from: resolveDate(current.from) }),
    ...(current.to === '' ? {} : { to: resolveDate(current.to) }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

function resolveDate(value: string): string {
  return value === 'today' ? today() : value;
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;

  try {
    const page = await api.office.bookings.list(requestQuery());
    items.value = page.items;
    nextCursor.value = page.nextCursor;
  } catch (caught) {
    error.value = officeMessage(caught);
  } finally {
    loading.value = false;
  }
}

async function loadMore(): Promise<void> {
  const cursor = nextCursor.value;
  if (cursor === null || loadingMore.value) return;

  loadingMore.value = true;

  try {
    const page = await api.office.bookings.list(requestQuery(cursor));
    // Appended, not replaced: a cursor page is a continuation, and re-sorting the union
    // would undo the total order the server established.
    items.value = [...items.value, ...page.items];
    nextCursor.value = page.nextCursor;
  } catch (caught) {
    error.value = officeMessage(caught);
  } finally {
    loadingMore.value = false;
  }
}

onMounted(load);
watch(filters, load);
</script>

<template>
  <section class="space-y-4">
    <h1 ref="heading" tabindex="-1" class="text-xl font-semibold tracking-tight outline-none">
      Bookings
    </h1>

    <form
      class="grid gap-3 rounded-sf border border-border bg-surface p-4 sm:grid-cols-2 lg:grid-cols-5"
      @submit.prevent="apply({ q: search })"
    >
      <SfInput
        v-model="search"
        label="Search"
        placeholder="Reference, name or email"
        data-test="search"
      />

      <SfSelect
        label="Status"
        :model-value="filters.status"
        :options="statusOptions"
        data-test="filter-status"
        @update:model-value="(value) => apply({ status: value })"
      />

      <SfInput
        type="date"
        label="From"
        :model-value="resolveDate(filters.from)"
        data-test="filter-from"
        @update:model-value="(value) => apply({ from: value })"
      />

      <SfInput
        type="date"
        label="To"
        :model-value="resolveDate(filters.to)"
        data-test="filter-to"
        @update:model-value="(value) => apply({ to: value })"
      />

      <SfSelect
        label="Order"
        :model-value="filters.sort"
        :options="SORT_OPTIONS"
        data-test="filter-sort"
        @update:model-value="(value) => apply({ sort: value })"
      />

      <div class="sm:col-span-2 lg:col-span-5">
        <SfButton type="submit" data-test="apply">Search</SfButton>
      </div>
    </form>

    <SfAlert v-if="error !== null" tone="danger" data-test="error">{{ error }}</SfAlert>

    <SfSkeleton v-if="loading && items.length === 0" class="h-64" />

    <p v-else-if="items.length === 0" class="text-text-secondary" data-test="empty">
      No bookings match these filters.
    </p>

    <div v-else class="overflow-x-auto rounded-sf border border-border">
      <table class="w-full min-w-160 text-sm">
        <caption class="sr-only">
          Bookings matching the current filters
        </caption>
        <thead class="bg-surface-muted text-left">
          <tr>
            <th scope="col" class="px-3 py-2 font-medium">When</th>
            <th scope="col" class="px-3 py-2 font-medium">Customer</th>
            <th scope="col" class="px-3 py-2 font-medium">Treatment</th>
            <th scope="col" class="px-3 py-2 font-medium">Person</th>
            <th scope="col" class="px-3 py-2 text-right font-medium">Price</th>
            <th scope="col" class="px-3 py-2 text-right font-medium">Paid</th>
            <th scope="col" class="px-3 py-2 font-medium">Status</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-border">
          <tr v-for="booking in items" :key="booking.id" class="hover:bg-surface-muted">
            <td class="px-3 py-2">
              <RouterLink
                :to="{ name: 'office-booking', params: { id: booking.id } }"
                class="font-medium tabular-nums hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                :data-test="`row-${booking.reference}`"
              >
                {{ dateTime(booking.startsAt) }}
              </RouterLink>
              <span class="block text-xs text-text-secondary">{{ booking.reference }}</span>
            </td>
            <td class="px-3 py-2">{{ booking.customerName }}</td>
            <td class="px-3 py-2">{{ booking.serviceName }}</td>
            <td class="px-3 py-2">{{ booking.employeeName }}</td>
            <td class="px-3 py-2 text-right tabular-nums">{{ money(booking.price) }}</td>
            <td
              class="px-3 py-2 text-right tabular-nums"
              :class="booking.paid.amountCents < booking.price.amountCents ? 'text-warning' : ''"
            >
              {{ money(booking.paid) }}
            </td>
            <td class="px-3 py-2"><StatusBadge :status="booking.displayStatus" /></td>
          </tr>
        </tbody>
      </table>
    </div>

    <SfButton
      v-if="nextCursor !== null"
      variant="secondary"
      :loading="loadingMore"
      loading-label="Loading"
      data-test="load-more"
      @click="loadMore"
    >
      Load more
    </SfButton>
  </section>
</template>
