<script setup lang="ts">
import { computed } from 'vue';

import SfIcon from './SfIcon.vue';

import type { IconName } from '../icon-paths.js';

/**
 * A message about something that just happened.
 *
 * The role depends on the tone, and the difference matters: `alert` interrupts a screen
 * reader immediately, which is right for a failure and rude for a confirmation. Anything
 * non-urgent is a polite `status`.
 */
const props = withDefaults(
  defineProps<{ tone?: 'info' | 'success' | 'warning' | 'danger'; title?: string | null }>(),
  { tone: 'info', title: null },
);

const urgent = computed(() => props.tone === 'danger' || props.tone === 'warning');

const toneClass = computed(
  () =>
    ({
      info: 'bg-surface-muted',
      success: 'bg-success',
      warning: 'bg-warning',
      danger: 'bg-danger',
    })[props.tone],
);

const icon = computed<IconName>(
  () =>
    ({
      info: 'clock',
      success: 'check',
      warning: 'triangle-exclamation',
      danger: 'triangle-exclamation',
    })[props.tone] as IconName,
);
</script>

<template>
  <div
    :class="toneClass"
    :role="urgent ? 'alert' : 'status'"
    :aria-live="urgent ? 'assertive' : 'polite'"
    class="flex gap-3 rounded-sf border border-border p-3 text-text-primary"
  >
    <SfIcon :name="icon" class="mt-0.5 shrink-0" />
    <div class="min-w-0">
      <p v-if="title !== null" class="font-semibold">{{ title }}</p>
      <div class="text-sm"><slot /></div>
    </div>
  </div>
</template>
