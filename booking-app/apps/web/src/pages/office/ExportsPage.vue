<script setup lang="ts">
import { bookingStatusSchema } from '@shape-and-flow/booking-contracts';
import { SfAlert, SfButton, SfCard, SfInput, SfSelect } from '@shape-and-flow/booking-ui';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';

import { api } from '../../api/client.js';
import { useFocusStep } from '../../composables/useFocusStep.js';
import { addDays } from '../../composables/useLocalDate.js';
import { localDateLabel, today } from '../../office/format.js';
import { registerOfficeMessages } from '../../office/i18n/index.js';

/**
 * The accounting hand-off.
 *
 * **The download goes through a hidden anchor, not through `fetch`.** The response is a
 * stream; fetching it would buffer a year of bookings into memory only to hand it back as
 * a blob. Navigating an anchor lets the browser do what it already does well — including
 * showing progress and writing straight to disk — and the session cookie rides along
 * because it is the same origin.
 *
 * The customer note is off by default. It is free text a customer wrote about themselves,
 * and a spreadsheet mailed to a bookkeeper is not where it belongs unless somebody decided
 * it does.
 */
registerOfficeMessages();

const { t } = useI18n();

useFocusStep('Exports');

const from = ref(addDays(today(), -30));
const to = ref(today());
const status = ref('');
const includeCustomerNote = ref(false);

const STATUS_OPTIONS = computed(() => [
  { value: '', label: t('office.exports.everyStatusOption') },
  ...bookingStatusSchema.options.map((value) => ({ value, label: value })),
]);

const rangeValid = computed(() => from.value !== '' && to.value !== '' && from.value <= to.value);

const anchor = ref<HTMLAnchorElement | null>(null);

function download(kind: 'bookings' | 'payments'): void {
  if (!rangeValid.value) return;

  const href = api.office.exportUrl(kind, {
    from: from.value,
    to: to.value,
    includeCustomerNote: kind === 'bookings' && includeCustomerNote.value,
    ...(status.value === '' ? {} : { status: [status.value] as never }),
  });

  const element = anchor.value;
  if (element === null) return;

  element.href = href;
  // The server sets `Content-Disposition: attachment` with the filename, so `download`
  // is left empty — naming it here would override what the server chose and the two would
  // drift.
  element.click();
}
</script>

<template>
  <section class="space-y-4">
    <h1 ref="heading" tabindex="-1" class="text-xl font-semibold tracking-tight outline-none">
      {{ t('office.exports.title') }}
    </h1>

    <SfCard as="section" aria-labelledby="range-heading">
      <h2 id="range-heading" class="text-lg font-medium">{{ t('office.exports.rangeHeading') }}</h2>

      <div class="mt-3 grid gap-3 sm:grid-cols-3">
        <SfInput v-model="from" type="date" :label="t('office.exports.fromLabel')" data-test="from" />
        <SfInput v-model="to" type="date" :label="t('office.exports.toLabel')" data-test="to" />
        <SfSelect
          :model-value="status"
          :label="t('office.exports.statusLabel')"
          :options="STATUS_OPTIONS"
          data-test="status"
          @update:model-value="(value) => (status = value)"
        />
      </div>

      <SfAlert v-if="!rangeValid" tone="warning" class="mt-3" data-test="range-problem">
        {{ t('office.exports.rangeInvalid') }}
      </SfAlert>

      <p v-else class="mt-3 text-sm text-text-secondary" data-test="range-summary">
        {{ t('office.exports.rangeSummary', { from: localDateLabel(from), to: localDateLabel(to) }) }}
      </p>
    </SfCard>

    <SfCard as="section" aria-labelledby="bookings-heading">
      <h2 id="bookings-heading" class="text-lg font-medium">
        {{ t('office.exports.bookingsHeading') }}
      </h2>
      <p class="text-sm text-text-secondary">
        {{ t('office.exports.bookingsDescription') }}
      </p>

      <label class="mt-3 flex items-center gap-2 text-sm">
        <input
          v-model="includeCustomerNote"
          type="checkbox"
          class="size-4 rounded-sf border-border"
          data-test="include-note"
        />
        {{ t('office.exports.includeCustomerNote') }}
      </label>

      <SfButton
        class="mt-3"
        :disabled="!rangeValid"
        data-test="download-bookings"
        @click="download('bookings')"
      >
        {{ t('office.exports.downloadBookings') }}
      </SfButton>
    </SfCard>

    <SfCard as="section" aria-labelledby="payments-heading">
      <h2 id="payments-heading" class="text-lg font-medium">
        {{ t('office.exports.paymentsHeading') }}
      </h2>
      <p class="text-sm text-text-secondary">
        {{ t('office.exports.paymentsDescription') }}
      </p>

      <SfButton
        class="mt-3"
        :disabled="!rangeValid"
        data-test="download-payments"
        @click="download('payments')"
      >
        {{ t('office.exports.downloadPayments') }}
      </SfButton>
    </SfCard>

    <p class="text-sm text-text-secondary">
      {{ t('office.exports.fileFormatNote') }}
    </p>

    <!-- Never displayed. It exists so the browser handles the streamed response itself. -->
    <a ref="anchor" class="hidden" aria-hidden="true" tabindex="-1" href="#">Download</a>
  </section>
</template>
