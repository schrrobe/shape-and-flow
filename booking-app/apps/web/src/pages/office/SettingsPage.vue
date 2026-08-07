<script setup lang="ts">
import {
  SETTINGS_BOUNDS,
  cancellationFeePolicySchema,
  updateOfficeSettingsSchema,
} from '@shape-and-flow/booking-contracts';
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
import { useAsyncData } from '../../composables/useAsyncData.js';
import { useFocusStep } from '../../composables/useFocusStep.js';
import { euros } from '../../office/format.js';
import { registerOfficeMessages } from '../../office/i18n/index.js';
import { officeMessage } from '../../office/messages.js';

import type {
  CancellationFeePolicy,
  OfficeSettingsResponse,
} from '@shape-and-flow/booking-contracts';

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
registerOfficeMessages();

const { t } = useI18n();

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
  cancellationFeePolicy: 'NONE',
  cancellationFeePercent: '0',
  cancellationFeeAmountEuros: '0.00',
  dataRetentionDays: '1095',
  officeNotificationEmail: '',
  reminderOffsetsMinutes: '1440',
  smsRemindersEnabled: 'false',
  customerNoteEnabled: 'true',
});

const INTERVAL_OPTIONS = computed(() =>
  SETTINGS_BOUNDS.schedulingIntervalMinutes.map((minutes) => ({
    value: String(minutes),
    label: t('office.settings.intervalOption', { minutes }),
  })),
);

const BOOLEAN_OPTIONS = computed(() => [
  { value: 'true', label: t('office.settings.yes') },
  { value: 'false', label: t('office.settings.no') },
]);

/**
 * Built from the enum, so a fourth policy cannot be added to the domain and quietly stay
 * unreachable from the only screen that sets it — which is how the percentage below came
 * to be inert for as long as it was.
 */
const FEE_POLICY_LABELS = computed<Record<string, string>>(() => ({
  NONE: t('office.settings.feePolicyNone'),
  PERCENTAGE: t('office.settings.feePolicyPercentage'),
  FIXED_AMOUNT: t('office.settings.feePolicyFixedAmount'),
}));

const FEE_POLICY_OPTIONS = computed(() =>
  cancellationFeePolicySchema.options.map((policy) => ({
    value: policy,
    label: FEE_POLICY_LABELS.value[policy] ?? policy,
  })),
);

/** Euros as typed, in cents. Comma or point, because a German keyboard offers both. */
function toCents(value: string): number {
  return Math.round(Number(value.trim().replace(',', '.')) * 100);
}

/**
 * The select hands back a string; the contract decides whether it is a policy.
 *
 * Every other field in this form is text on its way to a number, and this one is text on
 * its way to an enum — narrowed where the body is built rather than held as a typed value
 * the `<select>` would have to promise.
 */
function policyFrom(value: string): CancellationFeePolicy {
  const parsed = cancellationFeePolicySchema.safeParse(value);

  return parsed.success ? parsed.data : 'NONE';
}

function fill(settings: OfficeSettingsResponse): void {
  form.value = {
    schedulingIntervalMinutes: String(settings.schedulingIntervalMinutes),
    bookingHorizonDays: String(settings.bookingHorizonDays),
    minimumNoticeHours: String(settings.minimumNoticeHours),
    reservationTtlMinutes: String(settings.reservationTtlMinutes),
    freeCancellationHours: String(settings.freeCancellationHours),
    cancellationFeePolicy: settings.cancellationFeePolicy,
    cancellationFeePercent: String(settings.cancellationFeePercent),
    cancellationFeeAmountEuros: euros(settings.cancellationFeeAmountCents),
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
  // All three go every time, whichever policy is chosen. The two amounts are bounded
  // values the API validates either way, and keeping them means switching the policy back
  // does not silently lose the number that was set with it.
  cancellationFeePolicy: policyFrom(form.value.cancellationFeePolicy),
  cancellationFeePercent: Number(form.value.cancellationFeePercent),
  cancellationFeeAmountCents: toCents(form.value.cancellationFeeAmountEuros),
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
      {{ t('office.settings.title') }}
    </h1>

    <SfAlert v-if="errorKey !== null" tone="danger" data-test="error">
      {{ officeMessage(errorKey) }}
    </SfAlert>
    <SfAlert v-if="saveError !== null" tone="danger" data-test="save-error">{{
      saveError
    }}</SfAlert>
    <SfAlert v-if="saved" tone="success" data-test="saved">
      {{ t('office.settings.saved') }}
    </SfAlert>

    <SfSkeleton v-if="loading && data === null" class="h-96" />

    <!--
      On the settings the form appears only once the settings have been read. Settings are
      owner-only, and hanging the form off "not loading" put an editable form with a save
      button in front of anybody the API had just refused.
    -->
    <form v-else-if="data !== null" class="space-y-4" @submit.prevent="submit">
      <SfCard as="section" aria-labelledby="booking-heading">
        <h2 id="booking-heading" class="text-lg font-medium">
          {{ t('office.settings.bookingRulesHeading') }}
        </h2>

        <div class="mt-3 grid gap-3 sm:grid-cols-2">
          <SfSelect
            :model-value="form.schedulingIntervalMinutes"
            :label="t('office.settings.intervalLabel')"
            :options="INTERVAL_OPTIONS"
            data-test="interval"
            @update:model-value="(value) => (form.schedulingIntervalMinutes = value)"
          />

          <SfInput
            v-model="form.bookingHorizonDays"
            type="number"
            :label="t('office.settings.horizonLabel')"
            :min="SETTINGS_BOUNDS.bookingHorizonDays.min"
            :max="SETTINGS_BOUNDS.bookingHorizonDays.max"
            data-test="horizon"
          />

          <SfInput
            v-model="form.minimumNoticeHours"
            type="number"
            :label="t('office.settings.noticeLabel')"
            :min="SETTINGS_BOUNDS.minimumNoticeHours.min"
            :max="SETTINGS_BOUNDS.minimumNoticeHours.max"
            :description="t('office.settings.noticeDescription')"
            data-test="notice"
          />

          <SfInput
            v-model="form.reservationTtlMinutes"
            type="number"
            :label="t('office.settings.reservationTtlLabel')"
            :min="SETTINGS_BOUNDS.reservationTtlMinutes.min"
            :max="SETTINGS_BOUNDS.reservationTtlMinutes.max"
            data-test="reservation-ttl"
          />
        </div>
      </SfCard>

      <SfCard as="section" aria-labelledby="cancellation-heading">
        <h2 id="cancellation-heading" class="text-lg font-medium">
          {{ t('office.settings.cancellationHeading') }}
        </h2>

        <p class="mt-1 text-sm text-text-secondary">
          {{ t('office.settings.cancellationNoteBefore') }}
          <em>{{ t('office.settings.cancellationNoteEmphasis') }}</em>
          {{ t('office.settings.cancellationNoteAfter') }}
        </p>

        <div class="mt-3 grid gap-3 sm:grid-cols-2">
          <SfInput
            v-model="form.freeCancellationHours"
            type="number"
            :label="t('office.settings.freeCancellationLabel')"
            :min="SETTINGS_BOUNDS.freeCancellationHours.min"
            :max="SETTINGS_BOUNDS.freeCancellationHours.max"
            data-test="free-cancellation"
          />

          <SfSelect
            :model-value="form.cancellationFeePolicy"
            :label="t('office.settings.feePolicyLabel')"
            :options="FEE_POLICY_OPTIONS"
            data-test="fee-policy"
            @update:model-value="(value) => (form.cancellationFeePolicy = value)"
          />

          <SfInput
            v-if="form.cancellationFeePolicy === 'PERCENTAGE'"
            v-model="form.cancellationFeePercent"
            type="number"
            :label="t('office.settings.feePercentLabel')"
            :min="SETTINGS_BOUNDS.cancellationFeePercent.min"
            :max="SETTINGS_BOUNDS.cancellationFeePercent.max"
            data-test="fee-percent"
          />

          <SfInput
            v-if="form.cancellationFeePolicy === 'FIXED_AMOUNT'"
            v-model="form.cancellationFeeAmountEuros"
            inputmode="decimal"
            :label="t('office.settings.feeAmountLabel')"
            data-test="fee-amount"
          />
        </div>
      </SfCard>

      <SfCard as="section" aria-labelledby="messages-heading">
        <h2 id="messages-heading" class="text-lg font-medium">
          {{ t('office.settings.messagesHeading') }}
        </h2>

        <div class="mt-3 grid gap-3 sm:grid-cols-2">
          <SfInput
            v-model="form.officeNotificationEmail"
            type="email"
            :label="t('office.settings.officeEmailLabel')"
            data-test="office-email"
          />

          <SfInput
            v-model="form.reminderOffsetsMinutes"
            :label="t('office.settings.remindersLabel')"
            :description="t('office.settings.remindersDescription')"
            data-test="reminders"
          />

          <SfSelect
            :model-value="form.smsRemindersEnabled"
            :label="t('office.settings.smsLabel')"
            :options="BOOLEAN_OPTIONS"
            data-test="sms"
            @update:model-value="(value) => (form.smsRemindersEnabled = value)"
          />

          <SfSelect
            :model-value="form.customerNoteEnabled"
            :label="t('office.settings.customerNoteLabel')"
            :options="BOOLEAN_OPTIONS"
            data-test="customer-note"
            @update:model-value="(value) => (form.customerNoteEnabled = value)"
          />

          <SfInput
            v-model="form.dataRetentionDays"
            type="number"
            :label="t('office.settings.retentionLabel')"
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
        :loading-label="t('office.settings.saving')"
        data-test="save"
        @click="submit"
      >
        {{ t('office.settings.save') }}
      </SfButton>
    </form>
  </section>
</template>
