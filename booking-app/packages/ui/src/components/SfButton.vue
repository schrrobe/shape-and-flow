<script setup lang="ts">
import { computed } from 'vue';

import SfSpinner from './SfSpinner.vue';

/**
 * The one button.
 *
 * Two behaviours are not optional and are therefore here rather than at each call site: a
 * visible `focus-visible` ring, and swallowing clicks while loading or disabled. The second
 * is what stops a double-tap on a slow connection from creating two bookings — the
 * idempotency key catches it server-side, but a UI that fires twice is still a UI that lies
 * about what it did.
 */
const props = withDefaults(
  defineProps<{
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
    type?: 'button' | 'submit';
    loading?: boolean;
    disabled?: boolean;
    block?: boolean;
    loadingLabel?: string;
  }>(),
  {
    variant: 'primary',
    type: 'button',
    loading: false,
    disabled: false,
    block: false,
    loadingLabel: 'Loading',
  },
);

const emit = defineEmits<{ click: [MouseEvent] }>();

const inert = computed(() => props.loading || props.disabled);

const variantClass = computed(
  () =>
    ({
      primary: 'bg-primary text-primary-contrast hover:bg-primary-hover',
      secondary: 'bg-surface text-text-primary border border-border hover:bg-surface-muted',
      ghost: 'bg-transparent text-text-primary hover:bg-surface-muted',
      danger: 'bg-danger text-text-primary border border-border hover:brightness-95',
    })[props.variant],
);

function onClick(event: MouseEvent): void {
  // `disabled` already blocks a real click, but not a programmatic one, and `loading` has to
  // block both.
  if (inert.value) {
    event.preventDefault();
    return;
  }

  emit('click', event);
}
</script>

<template>
  <button
    :type="type"
    :disabled="inert"
    :aria-busy="loading ? 'true' : undefined"
    :class="[
      variantClass,
      block ? 'w-full' : '',
      'inline-flex items-center justify-center gap-2 rounded-sf px-4 py-2.5 text-base font-medium',
      'transition-colors',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2',
      'disabled:cursor-not-allowed disabled:opacity-60',
    ]"
    @click="onClick"
  >
    <SfSpinner v-if="loading" :label="loadingLabel" size="sm" />
    <slot />
  </button>
</template>
