<script setup lang="ts">
import { computed, useId } from 'vue';

/**
 * The multi-line sibling of `SfInput`, with a live character counter.
 *
 * The counter is `aria-live="polite"` and only announces near the limit: announcing every
 * keystroke would make the field unusable with a screen reader, and announcing nothing would
 * let somebody discover the limit by having their text truncated.
 */
const props = withDefaults(
  defineProps<{
    modelValue: string;
    label: string;
    description?: string | null;
    error?: string | null;
    maxlength?: number;
    rows?: number;
  }>(),
  { description: null, error: null, rows: 4 },
);

defineEmits<{ 'update:modelValue': [string] }>();

const id = useId();
const descriptionId = `${id}-description`;
const errorId = `${id}-error`;
const counterId = `${id}-counter`;

const remaining = computed(() =>
  props.maxlength === undefined ? null : props.maxlength - props.modelValue.length,
);

/** Only worth saying out loud once it is close. */
const announceCounter = computed(
  () => remaining.value !== null && props.maxlength !== undefined && remaining.value <= 50,
);

const describedBy = computed(() =>
  [
    props.description === null ? null : descriptionId,
    props.error === null ? null : errorId,
    remaining.value === null ? null : counterId,
  ]
    .filter((value): value is string => value !== null)
    .join(' '),
);
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <label :for="id" class="text-sm font-medium text-text-primary">{{ label }}</label>

    <textarea
      :id="id"
      :value="modelValue"
      :rows="rows"
      :maxlength="maxlength"
      :aria-describedby="describedBy === '' ? undefined : describedBy"
      :aria-invalid="error === null ? undefined : 'true'"
      class="rounded-sf border border-border bg-surface px-3 py-2.5 text-base text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-1"
      @input="$emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
    ></textarea>

    <p v-if="description !== null" :id="descriptionId" class="text-sm text-text-secondary">
      {{ description }}
    </p>
    <p v-if="error !== null" :id="errorId" class="text-sm font-medium text-text-primary">
      {{ error }}
    </p>
    <p
      v-if="remaining !== null"
      :id="counterId"
      class="text-right text-xs text-text-secondary"
      :aria-live="announceCounter ? 'polite' : 'off'"
    >
      {{ remaining }}
    </p>
  </div>
</template>
