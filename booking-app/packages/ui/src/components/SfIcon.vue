<script setup lang="ts">
import { computed } from 'vue';

import { ICON_PATHS } from '../icon-paths.js';

import type { IconName } from '../icon-paths.js';

/**
 * One of the ten curated icons.
 *
 * `name` is a union, not a string, so an icon outside the set is a type error rather than an
 * empty square at runtime — which is the whole reason the set is generated.
 */
const props = withDefaults(
  defineProps<{
    name: IconName;
    /**
     * An accessible name. Omit it for decoration: an icon beside its own label read twice is
     * noise, so the default is `aria-hidden`.
     */
    label?: string | null;
    size?: 'sm' | 'md' | 'lg';
  }>(),
  { label: null, size: 'md' },
);

const icon = computed(() => ICON_PATHS[props.name]);

const sizeClass = computed(() => ({ sm: 'h-3.5 w-3.5', md: 'h-4 w-4', lg: 'h-6 w-6' })[props.size]);
</script>

<template>
  <svg
    :class="sizeClass"
    :viewBox="icon.viewBox"
    :role="label === null ? undefined : 'img'"
    :aria-hidden="label === null ? 'true' : undefined"
    :aria-label="label ?? undefined"
    fill="currentColor"
    focusable="false"
  >
    <path :d="icon.path" />
  </svg>
</template>
