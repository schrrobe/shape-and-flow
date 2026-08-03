<script setup lang="ts">
/**
 * A placeholder while content loads.
 *
 * `aria-hidden`, deliberately: the shape means nothing to a screen reader, and the component
 * that owns the loading state announces it through `SfSpinner` instead. Announcing both would
 * be duplicate noise.
 */
withDefaults(defineProps<{ lines?: number; class?: string }>(), { lines: 3, class: '' });
</script>

<template>
  <div aria-hidden="true" class="flex flex-col gap-2">
    <div
      v-for="line in lines"
      :key="line"
      class="h-4 animate-pulse rounded-sf bg-surface-muted"
      :class="line === lines ? 'w-2/3' : 'w-full'"
    ></div>
  </div>
</template>
