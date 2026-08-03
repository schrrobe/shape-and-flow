<script setup lang="ts">
import { SfButton } from '@shape-and-flow/booking-ui';
import { onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';

import { api } from '../../api/client.js';
import SlotPicker from '../../components/SlotPicker.vue';
import { useAsyncData } from '../../composables/useAsyncData.js';
import { useFocusStep } from '../../composables/useFocusStep.js';
import { addDays, localDate } from '../../composables/useLocalDate.js';
import { useBookingDraft } from '../../stores/booking-draft.js';

const { t } = useI18n();
const router = useRouter();
const draft = useBookingDraft();
useFocusStep(t('booking.stepSlot'));

/** A week at a time. The API caps a range at 31 days; a week is what fits on a phone. */
const WINDOW_DAYS = 7;

// The reader's actual now, in the business timezone. The injected-Clock rule exists for the API,
// where tests control time; a booking page has to start from the real today or it offers slots in
// the past.
// eslint-disable-next-line no-restricted-syntax -- see above
const today = localDate(new Date());
const from = ref(today);

const { data, errorKey, loading, run } = useAsyncData((signal) =>
  api.public.availability(
    {
      serviceId: draft.serviceId ?? '',
      ...(draft.employeeId === null ? {} : { employeeId: draft.employeeId }),
      from: from.value,
      to: addDays(from.value, WINDOW_DAYS - 1),
    },
    signal,
  ),
);

onMounted(run);
watch(from, run);

function select(startsAt: Date): void {
  draft.setSlot(startsAt);
  void router.push({ name: 'booking-details' });
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <h1 ref="heading" tabindex="-1" class="text-xl font-semibold tracking-tight outline-none">
      {{ t('booking.slotTitle') }}
    </h1>

    <SlotPicker
      :availability="data"
      :loading="loading"
      :error-key="errorKey"
      :selected="draft.slot"
      :can-go-back="from > today"
      @select="select"
      @previous-week="from = addDays(from, -WINDOW_DAYS)"
      @next-week="from = addDays(from, WINDOW_DAYS)"
      @jump-to="from = $event"
      @retry="run"
    />

    <div>
      <SfButton variant="ghost" @click="router.push({ name: 'booking-employee' })">
        {{ t('common.back') }}
      </SfButton>
    </div>
  </div>
</template>
