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
import { addDays, localDate } from '../../composables/useLocalDate.js';
import { useManagementToken } from '../../composables/useManagementToken.js';

const { t } = useI18n();
useFocusStep(t('manage.rescheduleTitle'));

const { token, missing } = useManagementToken();

/** A week at a time, like the booking flow — the same picker, the same rhythm. */
const WINDOW_DAYS = 7;

// eslint-disable-next-line no-restricted-syntax -- the reader's real today; see StepSlot
const today = localDate(new Date());
const from = ref(today);

const selected = ref<Date | null>(null);
const submitting = ref(false);
const submitError = ref<string | null>(null);
const requested = ref(false);

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
    { from: from.value, to: addDays(from.value, WINDOW_DAYS - 1) },
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

watch(from, run);

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
          :can-go-back="from > today"
          @select="selected = $event"
          @previous-week="from = addDays(from, -WINDOW_DAYS)"
          @next-week="from = addDays(from, WINDOW_DAYS)"
          @jump-to="from = $event"
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
