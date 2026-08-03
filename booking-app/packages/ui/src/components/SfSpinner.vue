<script setup lang="ts">
import SfIcon from './SfIcon.vue';

/**
 * A busy indicator that says so out loud.
 *
 * `role="status"` with visually hidden text, because a spinning shape communicates nothing
 * to a screen reader. The caller passes the label so it can say what is loading.
 */
withDefaults(defineProps<{ label?: string; size?: 'sm' | 'md' | 'lg' }>(), {
  label: 'Loading',
  size: 'md',
});
</script>

<template>
  <span class="inline-flex items-center" role="status">
    <SfIcon name="spinner" :size="size" class="animate-spin" />
    <span class="sr-only">{{ label }}</span>
  </span>
</template>
