<script setup lang="ts">
import {
  SfAlert,
  SfButton,
  SfCard,
  SfInput,
  SfModal,
  SfSkeleton,
} from '@shape-and-flow/booking-ui';
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';

import { api } from '../../api/client.js';
import { useFocusStep } from '../../composables/useFocusStep.js';
import { date, money } from '../../office/format.js';
import { registerOfficeMessages } from '../../office/i18n/index.js';
import { officeMessage } from '../../office/messages.js';
import { useSession } from '../../stores/session.js';

import type { OfficeCustomer, OfficeCustomerDetail } from '@shape-and-flow/booking-contracts';

/**
 * The address book, and the one irreversible action in the office.
 *
 * **Erasure pseudonymises and keeps the bookings.** The confirmation says so in those
 * words, because "delete customer" would suggest the appointments go too — and an
 * operator who believed that would be surprised twice: once when the bookings remain, and
 * once when they discover the person's name cannot be recovered.
 */
registerOfficeMessages();

const { t } = useI18n();
const session = useSession();

useFocusStep(t('office.customers.title'));

const items = ref<OfficeCustomer[]>([]);
const nextCursor = ref<string | null>(null);
const search = ref('');
const loading = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);

const detail = ref<OfficeCustomerDetail | null>(null);
const editing = ref<OfficeCustomer | null>(null);
const erasing = ref<OfficeCustomer | null>(null);
const erased = ref<string | null>(null);

const form = ref({ firstName: '', lastName: '', email: '', phone: '', internalNote: '' });

/** The customer facing erasure, so the confirmation reads as a sentence rather than two names. */
const erasingName = computed(() =>
  `${erasing.value?.firstName ?? ''} ${erasing.value?.lastName ?? ''}`.trim(),
);

async function load(cursor?: string): Promise<void> {
  loading.value = true;
  error.value = null;

  try {
    const page = await api.office.customers.list({
      limit: 25,
      ...(search.value.trim() === '' ? {} : { q: search.value.trim() }),
      ...(cursor === undefined ? {} : { cursor }),
    });

    items.value = cursor === undefined ? page.items : [...items.value, ...page.items];
    nextCursor.value = page.nextCursor;
  } catch (caught) {
    error.value = officeMessage(caught);
  } finally {
    loading.value = false;
  }
}

async function open(customer: OfficeCustomer): Promise<void> {
  error.value = null;

  try {
    detail.value = await api.office.customers.detail(customer.id);
  } catch (caught) {
    error.value = officeMessage(caught);
  }
}

function startEdit(customer: OfficeCustomer): void {
  form.value = {
    firstName: customer.firstName,
    lastName: customer.lastName,
    email: customer.email,
    phone: customer.phone ?? '',
    internalNote: customer.internalNote ?? '',
  };
  editing.value = customer;
  error.value = null;
}

async function submitEdit(): Promise<void> {
  const customer = editing.value;
  if (customer === null || busy.value) return;

  busy.value = true;
  error.value = null;

  try {
    await api.office.customers.update(customer.id, {
      firstName: form.value.firstName.trim(),
      lastName: form.value.lastName.trim(),
      email: form.value.email.trim(),
      phone: form.value.phone.trim() === '' ? null : form.value.phone.trim(),
      internalNote: form.value.internalNote.trim() === '' ? null : form.value.internalNote.trim(),
    });
    editing.value = null;
    await load();
  } catch (caught) {
    error.value = officeMessage(caught);
  } finally {
    busy.value = false;
  }
}

async function confirmErase(): Promise<void> {
  const customer = erasing.value;
  if (customer === null || busy.value) return;

  busy.value = true;
  error.value = null;

  try {
    const result = await api.office.customers.erase(customer.id);
    erased.value = t(
      'office.customers.erasedMessage',
      { count: result.bookingsRetained },
      result.bookingsRetained,
    );
    erasing.value = null;
    detail.value = null;
    await load();
  } catch (caught) {
    error.value = officeMessage(caught);
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="space-y-4">
    <h1 ref="heading" tabindex="-1" class="text-xl font-semibold tracking-tight outline-none">
      {{ t('office.customers.title') }}
    </h1>

    <form class="flex flex-wrap items-end gap-3" @submit.prevent="load()">
      <SfInput
        v-model="search"
        :label="t('office.customers.searchLabel')"
        :placeholder="t('office.customers.searchPlaceholder')"
        class="min-w-64"
        data-test="search"
      />
      <SfButton type="submit" data-test="apply" @click="load()">
        {{ t('office.customers.searchButton') }}
      </SfButton>
    </form>

    <SfAlert v-if="error !== null" tone="danger" data-test="error">{{ error }}</SfAlert>
    <SfAlert v-if="erased !== null" tone="success" data-test="erased">{{ erased }}</SfAlert>

    <SfSkeleton v-if="loading && items.length === 0" class="h-48" />

    <ul v-else class="space-y-2">
      <li
        v-for="customer in items"
        :key="customer.id"
        class="flex flex-wrap items-center gap-3 rounded-sf border border-border bg-surface p-3"
        :data-test="`customer-${customer.id}`"
      >
        <span class="font-medium">{{ customer.firstName }} {{ customer.lastName }}</span>
        <span class="text-sm break-all text-text-secondary">{{ customer.email }}</span>
        <span v-if="customer.archivedAt !== null" class="text-sm text-text-secondary">
          {{ t('office.customers.erasedTag') }}
        </span>

        <span class="ml-auto flex gap-2">
          <SfButton variant="ghost" :data-test="`open-${customer.id}`" @click="open(customer)">
            {{ t('office.customers.historyButton') }}
          </SfButton>
          <SfButton variant="ghost" :data-test="`edit-${customer.id}`" @click="startEdit(customer)">
            {{ t('office.customers.editButton') }}
          </SfButton>
          <SfButton
            v-if="session.can('users.manage') && customer.archivedAt === null"
            variant="ghost"
            :data-test="`erase-${customer.id}`"
            @click="erasing = customer"
          >
            {{ t('office.customers.eraseButton') }}
          </SfButton>
        </span>
      </li>
    </ul>

    <SfButton
      v-if="nextCursor !== null"
      variant="secondary"
      data-test="load-more"
      @click="load(nextCursor ?? undefined)"
    >
      {{ t('office.customers.loadMore') }}
    </SfButton>

    <SfCard v-if="detail !== null" as="section" aria-labelledby="detail-heading">
      <div class="flex items-baseline justify-between">
        <h2 id="detail-heading" class="text-lg font-medium">
          {{ detail.firstName }} {{ detail.lastName }}
        </h2>
        <SfButton variant="ghost" data-test="close-detail" @click="detail = null">
          {{ t('office.customers.close') }}
        </SfButton>
      </div>

      <p class="mt-1 text-sm text-text-secondary">
        {{ t('office.customers.lifetimeValue', { amount: money(detail.lifetimeValue) }) }}
      </p>
      <p v-if="detail.internalNote !== null" class="mt-1 text-sm">{{ detail.internalNote }}</p>

      <ul class="mt-3 space-y-1 text-sm" data-test="customer-bookings">
        <li v-for="booking in detail.bookings" :key="booking.id" class="flex flex-wrap gap-3">
          <RouterLink
            :to="{ name: 'office-booking', params: { id: booking.id } }"
            class="tabular-nums underline"
          >
            {{ date(booking.startsAt) }}
          </RouterLink>
          <span>{{ booking.serviceName }}</span>
          <span class="text-text-secondary">{{ booking.status }}</span>
          <span class="ml-auto tabular-nums">{{ money(booking.price) }}</span>
        </li>
        <li v-if="detail.bookings.length === 0" class="text-text-secondary">
          {{ t('office.customers.noAppointments') }}
        </li>
      </ul>
    </SfCard>

    <SfModal
      :open="editing !== null"
      :title="t('office.customers.editModalTitle')"
      :confirm-label="t('office.customers.save')"
      :busy="busy"
      @close="editing = null"
      @confirm="submitEdit"
    >
      <div class="space-y-3">
        <SfInput
          v-model="form.firstName"
          :label="t('office.customers.firstNameLabel')"
          data-test="first-name"
        />
        <SfInput
          v-model="form.lastName"
          :label="t('office.customers.lastNameLabel')"
          data-test="last-name"
        />
        <SfInput
          v-model="form.email"
          type="email"
          :label="t('office.customers.emailLabel')"
          data-test="email"
        />
        <SfInput
          v-model="form.phone"
          type="tel"
          :label="t('office.customers.phoneLabel')"
          data-test="phone"
        />
        <SfInput
          v-model="form.internalNote"
          :label="t('office.customers.internalNoteLabel')"
          :description="t('office.customers.internalNoteHint')"
          data-test="internal-note"
        />
      </div>
    </SfModal>

    <SfModal
      :open="erasing !== null"
      :title="t('office.customers.eraseModalTitle')"
      :confirm-label="t('office.customers.eraseConfirmLabel')"
      confirm-variant="danger"
      :busy="busy"
      @close="erasing = null"
      @confirm="confirmErase"
    >
      <p>
        {{ t('office.customers.eraseIntro', { name: erasingName }) }}
        <strong>{{ t('office.customers.eraseStays') }}</strong>
        {{ t('office.customers.eraseReason') }}
      </p>
      <p class="mt-2">{{ t('office.customers.eraseRefused') }}</p>
    </SfModal>
  </section>
</template>
