<script setup lang="ts">
import { computed } from 'vue';

import { STATUS_PRESENTATION } from './status-presentation.js';

import type { DisplayStatus } from '@shape-and-flow/booking-contracts';

/**
 * A booking's status, as a word and a colour.
 *
 * The word is not optional. Roughly one operator in twelve cannot distinguish the green
 * from the amber, and a calendar where "cancelled" and "confirmed" differ only by hue is
 * one where somebody turns up to an appointment that is not happening. A test asserts
 * every status renders more than one character of text.
 */
const props = defineProps<{ status: DisplayStatus; compact?: boolean }>();

const presentation = computed(() => STATUS_PRESENTATION[props.status]);
</script>

<template>
  <span
    class="inline-flex items-center gap-1 rounded-sf px-2 py-0.5 text-xs font-medium"
    :class="presentation.className"
    :data-test="`status-${status}`"
    :data-status="status"
  >
    <span aria-hidden="true" class="text-[0.6rem] leading-none">{{ presentation.mark }}</span>
    <span :class="compact === true ? 'sr-only sm:not-sr-only' : ''">{{ presentation.label }}</span>
  </span>
</template>
