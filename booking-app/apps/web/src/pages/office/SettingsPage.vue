<script setup lang="ts">
import { SETTINGS_BOUNDS, updateOfficeSettingsSchema } from '@shape-and-flow/booking-contracts';
import {
  SfAlert,
  SfButton,
  SfCard,
  SfInput,
  SfSelect,
  SfSkeleton,
} from '@shape-and-flow/booking-ui';
import { computed, onMounted, ref } from 'vue';

import { api } from '../../api/client.js';
import { useAsyncData } from '../../composables/useAsyncData.js';
import { useFocusStep } from '../../composables/useFocusStep.js';
import { officeMessage } from '../../office/messages.js';

import type { OfficeSettingsResponse } from '@shape-and-flow/booking-contracts';

/**
 * Every policy the domain reads, in one form.
 *
 * **The bounds are imported, not re-typed.** `SETTINGS_BOUNDS` is the same table the API
 * builds its Zod schema from and the same one the integration suite compares against the
 * database `CHECK`, so a value this form accepts is one the server accepts. Writing `365`
 * here would be a fourth copy of the horizon.
 *
 * Saving reloads: the API refreshes its cached organization context on a successful
 * write, and the response is the state the domain will now use.
 */
useFocusStep('Settings');

const { data, errorKey, loading, run } = useAsyncData((signal) => api.office.settings.read(signal));

const saving = ref(false);
const saveError = ref<string | null>(null);
const saved = ref(false);

const form = ref({
  schedulingIntervalMinutes: '15',
  bookingHorizonDays: '180',
  minimumNoticeHours: '24',
  reservationTtlMinutes: '5',
  freeCancellationHours: '72',
  cancellationFeePercent: '0',
  dataRetentionDays: '1095',
  officeNotificationEmail: '',
  reminderOffsetsMinutes: '1440',
  smsRemindersEnabled: 'false',
  customerNoteEnabled: 'true',
});

const INTERVAL_OPTIONS = SETTINGS_BOUNDS.schedulingIntervalMinutes.map((minutes) => ({
  value: String(minutes),
  label: `${String(minutes)} minutes`,
}));

const BOOLEAN_OPTIONS = [
  { value: 'true', label: 'Yes' },
  { value: 'false', label: 'No' },
];

function fill(settings: OfficeSettingsResponse): void {
  form.value = {
    schedulingIntervalMinutes: String(settings.schedulingIntervalMinutes),
    bookingHorizonDays: String(settings.bookingHorizonDays),
    minimumNoticeHours: String(settings.minimumNoticeHours),
    reservationTtlMinutes: String(settings.reservationTtlMinutes),
    freeCancellationHours: String(settings.freeCancellationHours),
    cancellationFeePercent: String(settings.cancellationFeePercent),
    dataRetentionDays: String(settings.dataRetentionDays),
    officeNotificationEmail: settings.officeNotificationEmail,
    reminderOffsetsMinutes: settings.reminderOffsetsMinutes.join(', '),
    smsRemindersEnabled: String(settings.smsRemindersEnabled),
    customerNoteEnabled: String(settings.customerNoteEnabled),
  };
}

const body = computed(() => ({
  schedulingIntervalMinutes: Number(form.value.schedulingIntervalMinutes),
  bookingHorizonDays: Number(form.value.bookingHorizonDays),
  minimumNoticeHours: Number(form.value.minimumNoticeHours),
  reservationTtlMinutes: Number(form.value.reservationTtlMinutes),
  freeCancellationHours: Number(form.value.freeCancellationHours),
  cancellationFeePercent: Number(form.value.cancellationFeePercent),
  dataRetentionDays: Number(form.value.dataRetentionDays),
  officeNotificationEmail: form.value.officeNotificationEmail.trim(),
  reminderOffsetsMinutes: form.value.reminderOffsetsMinutes
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value) && value > 0),
  smsRemindersEnabled: form.value.smsRemindersEnabled === 'true',
  customerNoteEnabled: form.value.customerNoteEnabled === 'true',
}));

/** The contract's own verdict, so the form and the API cannot disagree. */
const problems = computed(() => {
  const result = updateOfficeSettingsSchema.safeParse(body.value);
  if (result.success) return [];

  return [
    ...new Set(result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)),
  ];
});

async function submit(): Promise<void> {
  if (problems.value.length > 0 || saving.value) return;

  saving.value = true;
  saveError.value = null;
  saved.value = false;

  try {
    const updated = await api.office.settings.update(body.value);
    fill(updated);
    saved.value = true;
  } catch (caught) {
    saveError.value = officeMessage(caught);
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  await run();
  if (data.value !== null) fill(data.value);
});
</script>

<template>
  <section class="space-y-4">
    <h1 ref="heading" tabindex="-1" class="text-xl font-semibold tracking-tight outline-none">
      Settings
    </h1>

    <SfAlert v-if="errorKey !== null" tone="danger" data-test="error">
      {{ officeMessage(errorKey) }}
    </SfAlert>
    <SfAlert v-if="saveError !== null" tone="danger" data-test="save-error">{{
      saveError
    }}</SfAlert>
    <SfAlert v-if="saved" tone="success" data-test="saved">
      Saved. New bookings use these rules from now on.
    </SfAlert>

    <SfSkeleton v-if="loading && data === null" class="h-96" />

    <form v-else class="space-y-4" @submit.prevent="submit">
      <SfCard as="section" aria-labelledby="booking-heading">
        <h2 id="booking-heading" class="text-lg font-medium">Booking rules</h2>

        <div class="mt-3 grid gap-3 sm:grid-cols-2">
          <SfSelect
            :model-value="form.schedulingIntervalMinutes"
            label="Slots every"
            :options="INTERVAL_OPTIONS"
            data-test="interval"
            @update:model-value="(value) => (form.schedulingIntervalMinutes = value)"
          />

          <SfInput
            v-model="form.bookingHorizonDays"
            type="number"
            label="Bookable how far ahead (days)"
            :min="SETTINGS_BOUNDS.bookingHorizonDays.min"
            :max="SETTINGS_BOUNDS.bookingHorizonDays.max"
            data-test="horizon"
          />

          <SfInput
            v-model="form.minimumNoticeHours"
            type="number"
            label="Shortest notice (hours)"
            :min="SETTINGS_BOUNDS.minimumNoticeHours.min"
            :max="SETTINGS_BOUNDS.minimumNoticeHours.max"
            description="The office may still book inside this window."
            data-test="notice"
          />

          <SfInput
            v-model="form.reservationTtlMinutes"
            type="number"
            label="Slot held during payment (minutes)"
            :min="SETTINGS_BOUNDS.reservationTtlMinutes.min"
            :max="SETTINGS_BOUNDS.reservationTtlMinutes.max"
            data-test="reservation-ttl"
          />
        </div>
      </SfCard>

      <SfCard as="section" aria-labelledby="cancellation-heading">
        <h2 id="cancellation-heading" class="text-lg font-medium">Cancellation</h2>

        <div class="mt-3 grid gap-3 sm:grid-cols-2">
          <SfInput
            v-model="form.freeCancellationHours"
            type="number"
            label="Free until (hours before)"
            :min="SETTINGS_BOUNDS.freeCancellationHours.min"
            :max="SETTINGS_BOUNDS.freeCancellationHours.max"
            data-test="free-cancellation"
          />

          <SfInput
            v-model="form.cancellationFeePercent"
            type="number"
            label="Fee inside that window (%)"
            :min="SETTINGS_BOUNDS.cancellationFeePercent.min"
            :max="SETTINGS_BOUNDS.cancellationFeePercent.max"
            data-test="fee-percent"
          />
        </div>
      </SfCard>

      <SfCard as="section" aria-labelledby="messages-heading">
        <h2 id="messages-heading" class="text-lg font-medium">Messages</h2>

        <div class="mt-3 grid gap-3 sm:grid-cols-2">
          <SfInput
            v-model="form.officeNotificationEmail"
            type="email"
            label="Where the office is notified"
            data-test="office-email"
          />

          <SfInput
            v-model="form.reminderOffsetsMinutes"
            label="Reminders (minutes before, comma separated)"
            description="1440 is a day. Duplicates are removed on save."
            data-test="reminders"
          />

          <SfSelect
            :model-value="form.smsRemindersEnabled"
            label="Send reminders by SMS"
            :options="BOOLEAN_OPTIONS"
            data-test="sms"
            @update:model-value="(value) => (form.smsRemindersEnabled = value)"
          />

          <SfSelect
            :model-value="form.customerNoteEnabled"
            label="Let customers leave a note"
            :options="BOOLEAN_OPTIONS"
            data-test="customer-note"
            @update:model-value="(value) => (form.customerNoteEnabled = value)"
          />

          <SfInput
            v-model="form.dataRetentionDays"
            type="number"
            label="Keep records for (days)"
            :min="SETTINGS_BOUNDS.dataRetentionDays.min"
            :max="SETTINGS_BOUNDS.dataRetentionDays.max"
            data-test="retention"
          />
        </div>
      </SfCard>

      <SfAlert v-if="problems.length > 0" tone="warning" data-test="problems">
        <ul class="list-inside list-disc">
          <li v-for="problem in problems" :key="problem">{{ problem }}</li>
        </ul>
      </SfAlert>

      <SfButton
        :disabled="problems.length > 0"
        :loading="saving"
        loading-label="Saving"
        data-test="save"
        @click="submit"
      >
        Save the settings
      </SfButton>
    </form>
  </section>
</template>
