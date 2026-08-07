<script setup lang="ts">
import { createManualBookingSchema } from '@shape-and-flow/booking-contracts';
import {
  SfAlert,
  SfButton,
  SfCard,
  SfInput,
  SfSelect,
  SfSkeleton,
  SfTextarea,
} from '@shape-and-flow/booking-ui';
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';

import { api } from '../../api/client.js';
import { ApiError } from '../../api/errors.js';
import { useFocusStep } from '../../composables/useFocusStep.js';
import { money, time, today } from '../../office/format.js';
import { registerOfficeMessages } from '../../office/i18n/index.js';
import { officeMessage } from '../../office/messages.js';
import { useSession } from '../../stores/session.js';

import type {
  AvailabilityResponse,
  CreateManualBookingRequest,
  OfficeCustomer,
  OfficeService,
} from '@shape-and-flow/booking-contracts';

/**
 * A booking taken by hand — the phone call, the walk-in, the regular who never uses the
 * website.
 *
 * **The times come from `GET /office/availability`, not from the public route.** The
 * office may book inside the minimum-notice window, and with the default 24 hours the
 * public answer for today is empty — which is exactly the day somebody is ringing about.
 * The list is therefore the set the server will accept: no free-text time to guess with,
 * and nothing offered that `POST /office/bookings` would refuse.
 *
 * The order of the form is the order of the conversation: what, when, with whom, for
 * whom. Each answer narrows the next, and the person is chosen from the slot rather than
 * before it, because "who is free at four" is the question actually being asked.
 */
const route = useRoute();
const router = useRouter();
const session = useSession();

registerOfficeMessages();
const { t } = useI18n();

useFocusStep('New booking');

const mayCreate = computed(() => session.can('booking.create'));

const services = ref<OfficeService[]>([]);
const employeeNames = ref<Map<string, string>>(new Map());
const setupError = ref<string | null>(null);
const loadingSetup = ref(true);

const slots = ref<AvailabilityResponse['days'][number]['slots']>([]);
const slotsError = ref<string | null>(null);
const loadingSlots = ref(false);

const serviceId = ref('');
const date = ref(typeof route.query.date === 'string' ? route.query.date : today());
const startsAt = ref('');
const employeeId = ref(typeof route.query.employeeId === 'string' ? route.query.employeeId : '');

/** An existing customer, once one is picked. Clearing it hands the form back to the fields. */
const customer = ref<OfficeCustomer | null>(null);
const search = ref('');
const matches = ref<OfficeCustomer[]>([]);
const searching = ref(false);
const searched = ref(false);

const newCustomer = ref({ email: '', firstName: '', lastName: '', phone: '', locale: 'de' });
const note = ref('');

const saving = ref(false);
const saveError = ref<string | null>(null);

/**
 * One key per attempt, and a new one whenever the details change.
 *
 * The API hashes the body against the key, so replaying a key with different details is
 * `IDEMPOTENCY_KEY_REUSED` rather than a second booking. Keeping the key across a retry
 * of the *same* body is the point: a double click, or a click after a dropped
 * connection, must not put two appointments in the diary.
 */
const idempotencyKey = ref<string | null>(null);

/** Only what the office can actually sell. Reserving refuses anything else. */
const serviceOptions = computed(() => [
  { value: '', label: t('office.newBooking.chooseTreatment') },
  ...services.value
    .filter((service) => service.archivedAt === null && service.isBookableOnline)
    .map((service) => ({
      value: service.id,
      label: `${service.name} · ${String(service.durationMinutes)} min · ${money(service.price)}`,
    })),
]);

const selectedSlot = computed(() => slots.value.find((slot) => slot.startsAt === startsAt.value));

/** The people free at the chosen time, which is a property of the slot. */
const employeeOptions = computed(() => {
  const candidates = selectedSlot.value?.employeeIds ?? [];

  return candidates.map((id) => ({
    value: id,
    label: employeeNames.value.get(id) ?? t('office.newBooking.unknownPerson'),
  }));
});

const customerBody = computed((): CreateManualBookingRequest['customer'] => {
  if (customer.value !== null) return { customerId: customer.value.id };

  return {
    email: newCustomer.value.email.trim(),
    firstName: newCustomer.value.firstName.trim(),
    lastName: newCustomer.value.lastName.trim(),
    ...(newCustomer.value.phone.trim() === '' ? {} : { phone: newCustomer.value.phone.trim() }),
    locale: newCustomer.value.locale === 'en' ? 'en' : 'de',
  };
});

const body = computed(() => ({
  serviceId: serviceId.value,
  employeeId: employeeId.value,
  startsAt: startsAt.value,
  customer: customerBody.value,
  ...(note.value.trim() === '' ? {} : { customerNote: note.value.trim() }),
}));

/** The contract's own verdict, so the form refuses exactly what the API would. */
const problems = computed(() => {
  const result = createManualBookingSchema.safeParse(body.value);
  if (result.success) return [];

  return [
    ...new Set(result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)),
  ];
});

async function loadSetup(): Promise<void> {
  loadingSetup.value = true;

  try {
    const [serviceList, employeeList] = await Promise.all([
      api.office.catalog.services({ includeArchived: false }),
      api.office.employees.list(false),
    ]);

    services.value = serviceList.items;
    employeeNames.value = new Map(
      employeeList.items.map((employee) => [employee.id, employee.displayName]),
    );
  } catch (caught) {
    setupError.value = officeMessage(caught);
  } finally {
    loadingSetup.value = false;
  }
}

async function loadSlots(): Promise<void> {
  startsAt.value = '';

  if (serviceId.value === '' || date.value === '') {
    slots.value = [];
    return;
  }

  loadingSlots.value = true;
  slotsError.value = null;

  try {
    const response = await api.office.availability.slots({
      serviceId: serviceId.value,
      from: date.value,
      to: date.value,
    });

    slots.value = response.days[0]?.slots ?? [];
  } catch (caught) {
    slots.value = [];
    slotsError.value = officeMessage(caught);
  } finally {
    loadingSlots.value = false;
  }
}

function pickSlot(start: string): void {
  startsAt.value = start;

  const candidates = selectedSlot.value?.employeeIds ?? [];

  // A single candidate is an answer, not a question. Otherwise the previous choice is
  // kept when that person is also free at the new time, so changing the hour does not
  // silently reassign the appointment.
  if (candidates.length === 1) employeeId.value = candidates[0] ?? '';
  else if (!candidates.includes(employeeId.value)) employeeId.value = '';
}

async function runSearch(): Promise<void> {
  const q = search.value.trim();
  if (q === '' || searching.value) return;

  searching.value = true;

  try {
    const response = await api.office.customers.list({ q, limit: 5 });
    matches.value = response.items;
    searched.value = true;
  } catch (caught) {
    saveError.value = officeMessage(caught);
  } finally {
    searching.value = false;
  }
}

function choose(picked: OfficeCustomer): void {
  customer.value = picked;
  matches.value = [];
  searched.value = false;
}

function clearCustomer(): void {
  customer.value = null;
}

async function submit(): Promise<void> {
  if (problems.value.length > 0 || saving.value) return;

  saving.value = true;
  saveError.value = null;
  idempotencyKey.value ??= crypto.randomUUID();

  try {
    const created = await api.office.bookings.create(body.value, idempotencyKey.value);
    await router.push({ name: 'office-booking', params: { id: created.bookingId } });
  } catch (caught) {
    saveError.value = officeMessage(caught);

    // Only a conflict re-reads the day. `SLOT_UNAVAILABLE` means somebody else took the
    // time, so continuing to offer it would be a lie — but a 500 or a dropped connection
    // says nothing about the slot, and clearing the form would throw away a filled-in
    // booking and the idempotency key that makes retrying it safe.
    if (caught instanceof ApiError && caught.code === 'SLOT_UNAVAILABLE') await loadSlots();
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  if (!mayCreate.value) {
    loadingSetup.value = false;
    return;
  }

  await loadSetup();
  await loadSlots();
});

// A changed body is a different request, so the key it would be sent with has to change
// too — otherwise the API answers `IDEMPOTENCY_KEY_REUSED` and the operator is told to
// start again for no reason.
watch(body, () => {
  idempotencyKey.value = null;
});

watch([serviceId, date], loadSlots);
</script>

<template>
  <section class="space-y-4">
    <h1 ref="heading" tabindex="-1" class="text-xl font-semibold tracking-tight outline-none">
      {{ t('office.newBooking.heading') }}
    </h1>

    <SfAlert v-if="!mayCreate" tone="warning" data-test="forbidden">
      {{ t('office.newBooking.forbidden') }}
    </SfAlert>

    <template v-else>
      <SfAlert v-if="setupError !== null" tone="danger" data-test="error">{{ setupError }}</SfAlert>
      <SfAlert v-if="saveError !== null" tone="danger" data-test="save-error">{{
        saveError
      }}</SfAlert>

      <SfSkeleton v-if="loadingSetup" class="h-96" />

      <form v-else class="space-y-4" @submit.prevent="submit">
        <SfCard as="section" aria-labelledby="what-heading">
          <h2 id="what-heading" class="text-lg font-medium">
            {{ t('office.newBooking.whatHeading') }}
          </h2>

          <div class="mt-3 grid gap-3 sm:grid-cols-2">
            <SfSelect
              :model-value="serviceId"
              :label="t('office.newBooking.treatmentLabel')"
              :options="serviceOptions"
              data-test="service"
              @update:model-value="(value) => (serviceId = value)"
            />

            <SfInput
              v-model="date"
              type="date"
              :label="t('office.newBooking.dayLabel')"
              data-test="date"
            />
          </div>
        </SfCard>

        <SfCard as="section" aria-labelledby="when-heading">
          <h2 id="when-heading" class="text-lg font-medium">
            {{ t('office.newBooking.whenHeading') }}
          </h2>

          <p class="mt-1 text-sm text-text-secondary">
            {{ t('office.newBooking.slotsHint') }}
          </p>

          <SfAlert v-if="slotsError !== null" tone="danger" class="mt-3" data-test="slots-error">
            {{ slotsError }}
          </SfAlert>

          <SfSkeleton v-else-if="loadingSlots" class="mt-3 h-20" />

          <p v-else-if="serviceId === ''" class="mt-3 text-sm text-text-secondary">
            {{ t('office.newBooking.chooseTreatmentFirst') }}
          </p>

          <p v-else-if="slots.length === 0" class="mt-3 text-sm" data-test="no-slots">
            {{ t('office.newBooking.noSlots') }}
          </p>

          <ul v-else class="mt-3 flex flex-wrap gap-2">
            <li v-for="slot in slots" :key="slot.startsAt">
              <SfButton
                :variant="slot.startsAt === startsAt ? 'primary' : 'secondary'"
                :aria-pressed="slot.startsAt === startsAt"
                data-test="slot"
                :data-start="slot.startsAt"
                @click="pickSlot(slot.startsAt)"
              >
                {{ time(slot.startsAt) }}
              </SfButton>
            </li>
          </ul>

          <div v-if="startsAt !== ''" class="mt-3 max-w-sm">
            <SfSelect
              :model-value="employeeId"
              :label="t('office.newBooking.withLabel')"
              :options="[
                { value: '', label: t('office.newBooking.choosePerson') },
                ...employeeOptions,
              ]"
              data-test="employee"
              @update:model-value="(value) => (employeeId = value)"
            />
          </div>
        </SfCard>

        <SfCard as="section" aria-labelledby="who-heading">
          <h2 id="who-heading" class="text-lg font-medium">
            {{ t('office.newBooking.whoHeading') }}
          </h2>

          <div v-if="customer !== null" class="mt-3 flex flex-wrap items-baseline gap-3">
            <p data-test="chosen-customer">
              {{ customer.firstName }} {{ customer.lastName }}
              <span class="text-text-secondary">{{ customer.email }}</span>
            </p>
            <SfButton variant="ghost" data-test="clear-customer" @click="clearCustomer">
              {{ t('office.newBooking.someoneElse') }}
            </SfButton>
          </div>

          <template v-else>
            <div class="mt-3 flex flex-wrap items-end gap-2">
              <div class="min-w-60 flex-1">
                <SfInput
                  v-model="search"
                  :label="t('office.newBooking.findCustomerLabel')"
                  :description="t('office.newBooking.findCustomerHint')"
                  data-test="customer-search"
                />
              </div>
              <SfButton
                variant="secondary"
                :loading="searching"
                :loading-label="t('office.newBooking.searching')"
                data-test="search"
                @click="runSearch"
              >
                {{ t('office.newBooking.search') }}
              </SfButton>
            </div>

            <ul v-if="matches.length > 0" class="mt-3 divide-y divide-border">
              <li v-for="match in matches" :key="match.id" class="flex items-baseline gap-3 py-2">
                <SfButton
                  variant="ghost"
                  data-test="pick-customer"
                  :data-customer="match.id"
                  @click="choose(match)"
                >
                  {{ match.firstName }} {{ match.lastName }}
                </SfButton>
                <span class="text-sm text-text-secondary">{{ match.email }}</span>
              </li>
            </ul>

            <p v-else-if="searched" class="mt-3 text-sm text-text-secondary" data-test="no-matches">
              {{ t('office.newBooking.noMatches') }}
            </p>

            <div class="mt-4 grid gap-3 sm:grid-cols-2">
              <SfInput
                v-model="newCustomer.firstName"
                :label="t('office.newBooking.firstNameLabel')"
                data-test="first-name"
              />
              <SfInput
                v-model="newCustomer.lastName"
                :label="t('office.newBooking.lastNameLabel')"
                data-test="last-name"
              />
              <SfInput
                v-model="newCustomer.email"
                type="email"
                :label="t('office.newBooking.emailLabel')"
                :description="t('office.newBooking.emailHint')"
                data-test="email"
              />
              <SfInput
                v-model="newCustomer.phone"
                type="tel"
                :label="t('office.newBooking.phoneLabel')"
                data-test="phone"
              />
              <SfSelect
                :model-value="newCustomer.locale"
                :label="t('office.newBooking.localeLabel')"
                :options="[
                  { value: 'de', label: t('office.newBooking.localeGerman') },
                  { value: 'en', label: t('office.newBooking.localeEnglish') },
                ]"
                data-test="locale"
                @update:model-value="(value) => (newCustomer.locale = value)"
              />
            </div>
          </template>

          <div class="mt-3">
            <SfTextarea
              v-model="note"
              :label="t('office.newBooking.noteLabel')"
              :description="t('office.newBooking.noteHint')"
              :maxlength="2000"
              data-test="note"
            />
          </div>
        </SfCard>

        <SfAlert v-if="problems.length > 0" tone="warning" data-test="problems">
          <ul class="list-inside list-disc">
            <li v-for="problem in problems" :key="problem">{{ problem }}</li>
          </ul>
        </SfAlert>

        <!--
          Confirmed directly, with no payment and no Checkout session: §6.5. The money is
          recorded afterwards on the booking, which is also what happens when somebody
          pays in cash at the desk.
        -->
        <SfButton
          :disabled="problems.length > 0"
          :loading="saving"
          :loading-label="t('office.newBooking.bookingLoading')"
          data-test="create"
          @click="submit"
        >
          {{ t('office.newBooking.submit') }}
        </SfButton>
      </form>
    </template>
  </section>
</template>
