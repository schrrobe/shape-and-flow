<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';

/**
 * How long is left on the reservation.
 *
 * Shown before the customer leaves for Stripe, not discovered afterwards: the slot is held for
 * five minutes, and somebody who wanders off mid-payment should have been told that up front.
 *
 * Two accessibility decisions worth keeping. The region is `aria-live="polite"`, so a screen
 * reader mentions it when it changes rather than interrupting — and the ticking digits are
 * `aria-hidden`, because announcing a new value every second would make the page unusable. What
 * gets announced is the surrounding sentence, which changes rarely.
 */
const props = defineProps<{ expiresAt: Date }>();

const emit = defineEmits<{ expired: [] }>();

const { t } = useI18n();

/** Under a minute is when somebody needs to hurry, so that is when the styling changes. */
const WARN_BELOW_MS = 60_000;

/*
 * The wall clock, deliberately.
 *
 * The injected-Clock rule exists for the API, where a test has to control time. A countdown in a
 * browser has no clock to inject and must compare against the reader's actual now — a frozen one
 * would show a reservation as valid after it lapsed. Disabled per line rather than per file,
 * because `no-restricted-syntax` is a single rule and exempting the file would also drop the
 * cent-arithmetic ban.
 */
// eslint-disable-next-line no-restricted-syntax -- see above
const remainingMs = ref(Math.max(0, props.expiresAt.getTime() - Date.now()));

let timer: ReturnType<typeof setInterval> | undefined;
/** Emitted exactly once: a repeated `expired` would re-trigger whatever the parent does. */
let announced = false;

function tick(): void {
  // eslint-disable-next-line no-restricted-syntax -- see the note above
  remainingMs.value = Math.max(0, props.expiresAt.getTime() - Date.now());

  if (remainingMs.value > 0 || announced) return;

  announced = true;
  stop();
  emit('expired');
}

function stop(): void {
  if (timer === undefined) return;
  clearInterval(timer);
  timer = undefined;
}

onMounted(() => {
  // Checked immediately: a reservation can already be expired when the page loads, and waiting a
  // second to say so shows a countdown that was never true.
  tick();
  timer = setInterval(tick, 1000);
});

onBeforeUnmount(stop);

const formatted = computed(() => {
  const totalSeconds = Math.ceil(remainingMs.value / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
});

const expired = computed(() => remainingMs.value <= 0);
const warning = computed(() => !expired.value && remainingMs.value < WARN_BELOW_MS);
</script>

<template>
  <p
    aria-live="polite"
    class="inline-flex items-center gap-2 rounded-sf px-3 py-1.5 text-sm"
    :class="
      expired
        ? 'bg-danger font-medium'
        : warning
          ? 'bg-danger font-medium'
          : 'bg-surface-muted text-text-secondary'
    "
  >
    <template v-if="expired">{{ t('booking.countdownExpired') }}</template>
    <template v-else>
      <!-- The sentence is announced; the digits are not, or a screen reader would read a new
           number every second. -->
      {{ t('booking.countdownLabel', { time: '' }).trim() }}
      <span aria-hidden="true" class="font-mono tabular-nums">{{ formatted }}</span>
    </template>
  </p>
</template>
