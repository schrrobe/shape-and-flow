<script setup lang="ts">
import { computed } from 'vue';

/**
 * A short status label.
 *
 * Colour is never the only carrier: the text says the status too, so it survives a
 * greyscale print, a colour-blind reader, and a screen reader.
 */
const props = withDefaults(defineProps<{ tone?: 'neutral' | 'success' | 'warning' | 'danger' }>(), {
  tone: 'neutral',
});

const toneClass = computed(
  () =>
    ({
      neutral: 'bg-surface-muted',
      success: 'bg-success',
      warning: 'bg-warning',
      danger: 'bg-danger',
    })[props.tone],
);
</script>

<template>
  <span
    :class="toneClass"
    class="inline-flex items-center rounded-full px-2.5 py-0.5 text-sm font-medium text-text-primary"
  >
    <slot />
  </span>
</template>
