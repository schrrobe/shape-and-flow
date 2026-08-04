<script setup lang="ts">
import { SfAlert, SfButton, SfCard } from '@shape-and-flow/booking-ui';
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

import { api } from '../../api/client.js';
import { messageKeyFor } from '../../api/errors.js';
import SlotPicker from '../../components/SlotPicker.vue';
import WhatsAppButton from '../../components/WhatsAppButton.vue';
import { useAsyncData } from '../../composables/useAsyncData.js';
import { useFocusStep } from '../../composables/useFocusStep.js';
import { addMonths, endOfMonth, localDate, startOfMonth } from '../../composables/useLocalDate.js';
import { useManagementToken } from '../../composables/useManagementToken.js';

const { t } = useI18n();
useFocusStep(t('manage.rescheduleTitle'));

const { token, missing } = useManagementToken();

// eslint-disable-next-line no-restricted-syntax -- the reader's real today; see StepSlot
const today = localDate(new Date());
const monthAnchor = ref(startOfMonth(today));
const selectedDate = ref(today);

const selected = ref<Date | null>(null);
const submitting = ref(false);
const submitError = ref<string | null>(null);
const requested = ref(false);

/** Never asks for a day before today, even when the displayed month starts earlier. */
function clampToToday(date: string): string {
  return date < today ? today : date;
}

const {
  data: booking,
  errorKey: bookingErrorKey,
  run: loadBooking,
} = useAsyncData((signal) => api.manage.booking(token.value ?? '', signal));

const {
  data: availability,
  errorKey,
  loading,
  run,
} = useAsyncData((signal) =>
  api.manage.availability(
    token.value ?? '',
    { from: clampToToday(monthAnchor.value), to: endOfMonth(monthAnchor.value) },
    signal,
  ),
);

const { data: organization, run: loadOrganization } = useAsyncData((signal) =>
  api.public.organization(signal),
);

const linkDead = computed(
  () => missing.value || bookingErrorKey.value === 'errors.UNAUTHENTICATED',
);

onMounted(() => {
  if (missing.value) return;

  void loadBooking();
  void loadOrganization();
  void run();
});

watch(monthAnchor, run);

// Same fallback as StepSlot: freshly loaded data jumps the selection to the first day that has
// something free, so paging to a month never lands the reader on an empty day by default.
watch(availability, (value) => {
  if (value === null) return;

  const selectedHasSlots = value.days.some(
    (day) => day.date === selectedDate.value && day.slots.length > 0,
  );
  if (selectedHasSlots) return;

  const firstWithSlots = value.days.find((day) => day.slots.length > 0);
  if (firstWithSlots !== undefined) selectedDate.value = firstWithSlots.date;
});

watch(selectedDate, () => {
  // A slot belongs to the day it was offered in. Left standing across a day change it is a
  // highlighted choice the customer can no longer see, with the submit button still enabled —
  // and on a page that moves a real appointment, submitting an invisible time is a silent
  // wrong action rather than a cosmetic slip.
  selected.value = null;
});

function goToMonth(months: number): void {
  monthAnchor.value = addMonths(monthAnchor.value, months);
  selectedDate.value = clampToToday(monthAnchor.value);
}

async function submit(): Promise<void> {
  const startsAt = selected.value;
  if (startsAt === null || submitting.value) return;

  submitting.value = true;
  submitError.value = null;

  try {
    await api.manage.requestReschedule(token.value ?? '', {
      requestedStartsAt: startsAt.toISOString(),
    });

    requested.value = true;
  } catch (error) {
    submitError.value = messageKeyFor(error);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <SfCard v-if="linkDead" as="section">
      <h1 ref="heading" tabindex="-1" class="text-xl font-semibold outline-none">
        {{ t('manage.missingTitle') }}
      </h1>
      <p class="mt-2 text-text-secondary">{{ t('manage.missingBody') }}</p>
    </SfCard>

    <template v-else>
      <SfCard as="section">
        <h1 ref="heading" tabindex="-1" class="text-xl font-semibold outline-none">
          {{ t('manage.rescheduleTitle') }}
        </h1>

        <!-- Said before anything is chosen. A customer who picks a slot expecting it to be theirs,
             and only then learns the office has to agree, has been misled by the interface. -->
        <p class="mt-2 text-text-secondary">{{ t('manage.rescheduleNeedsApproval') }}</p>
      </SfCard>

      <SfAlert v-if="requested" tone="success" :title="t('manage.requestedTitle')">
        {{ t('manage.rescheduleRequested') }}
      </SfAlert>

      <SfCard v-else as="section">
        <!-- The same picker as the booking flow, against `/manage/availability` — which offers the
             booking's own service, so a reschedule cannot quietly change what was bought. -->
        <SlotPicker
          :availability="availability"
          :loading="loading"
          :error-key="errorKey"
          :selected="selected"
          :month-anchor="monthAnchor"
          :selected-date="selectedDate"
          :today="today"
          :can-go-back="monthAnchor > startOfMonth(today)"
          @select="selected = $event"
          @select-date="selectedDate = $event"
          @previous-month="goToMonth(-1)"
          @next-month="goToMonth(1)"
          @jump-to="selectedDate = $event"
          @retry="run"
        />

        <SfAlert v-if="submitError !== null" tone="danger" class="mt-4">
          {{ t(submitError) }}
        </SfAlert>

        <div class="mt-4">
          <SfButton :disabled="selected === null" :loading="submitting" @click="submit">
            {{ t('manage.rescheduleSubmit') }}
          </SfButton>
        </div>
      </SfCard>

      <div>
        <WhatsAppButton
          :number="organization?.whatsappNumber ?? null"
          :reference="booking?.reference ?? null"
        />
      </div>
    </template>
  </div>
</template>
