<script setup lang="ts">
import { computed, useId } from 'vue';

import { useFieldTestId } from './field-test-id.js';

/** A labelled native select. Native, because a custom listbox is a keyboard-support project. */
const props = withDefaults(
  defineProps<{
    modelValue: string;
    label: string;
    options: { value: string; label: string }[];
    description?: string | null;
    error?: string | null;
    required?: boolean;
  }>(),
  { description: null, error: null, required: false },
);

defineEmits<{ 'update:modelValue': [string] }>();

const id = useId();
const descriptionId = `${id}-description`;
const errorId = `${id}-error`;

const describedBy = computed(() => {
  const ids = [
    props.description === null ? null : descriptionId,
    props.error === null ? null : errorId,
  ].filter((value): value is string => value !== null);

  return ids.length === 0 ? undefined : ids.join(' ');
});

// The test id belongs on the control, not on the block around it.
defineOptions({ inheritAttrs: false });
const { testId, wrapperAttrs } = useFieldTestId();
</script>

<template>
  <div class="flex flex-col gap-1.5" v-bind="wrapperAttrs">
    <label :for="id" class="text-sm font-medium text-text-primary">
      {{ label }}
      <span v-if="required" aria-hidden="true" class="text-primary">*</span>
    </label>

    <select
      :id="id"
      :data-test="testId"
      :value="modelValue"
      :required="required"
      :aria-describedby="describedBy"
      :aria-invalid="error === null ? undefined : 'true'"
      class="rounded-sf border border-border bg-surface px-3 py-2.5 text-base text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-1"
      @change="$emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
    >
      <option v-for="option in options" :key="option.value" :value="option.value">
        {{ option.label }}
      </option>
    </select>

    <p v-if="description !== null" :id="descriptionId" class="text-sm text-text-secondary">
      {{ description }}
    </p>
    <p v-if="error !== null" :id="errorId" class="text-sm font-medium text-text-primary">
      {{ error }}
    </p>
  </div>
</template>
