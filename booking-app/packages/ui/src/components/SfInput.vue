<script setup lang="ts">
import { computed, useId } from 'vue';

/**
 * A labelled text field that describes itself correctly.
 *
 * The three-way `aria-describedby` is the point of this component. A field with a hint and an
 * error has to announce both, in that order, and `aria-invalid` has to be set — otherwise a
 * screen-reader user hears the label, types, and never learns why the form refused. Getting
 * that right once here is worth more than ten hand-rolled inputs.
 */
const props = withDefaults(
  defineProps<{
    modelValue: string;
    label: string;
    type?: 'text' | 'email' | 'tel' | 'password';
    description?: string | null;
    error?: string | null;
    required?: boolean;
    autocomplete?: string;
    maxlength?: number;
    placeholder?: string;
  }>(),
  // `autocomplete`, `maxlength` and `placeholder` get no default: an optional prop is already
  // undefined, and `exactOptionalPropertyTypes` rejects saying so twice.
  { type: 'text', description: null, error: null, required: false },
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
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <label :for="id" class="text-sm font-medium text-text-primary">
      {{ label }}
      <span v-if="required" aria-hidden="true" class="text-primary">*</span>
    </label>

    <input
      :id="id"
      :type="type"
      :value="modelValue"
      :required="required"
      :autocomplete="autocomplete"
      :maxlength="maxlength"
      :placeholder="placeholder"
      :aria-describedby="describedBy"
      :aria-invalid="error === null ? undefined : 'true'"
      class="rounded-sf border border-border bg-surface px-3 py-2.5 text-base text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-1"
      @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />

    <p v-if="description !== null" :id="descriptionId" class="text-sm text-text-secondary">
      {{ description }}
    </p>
    <p v-if="error !== null" :id="errorId" class="text-sm font-medium text-text-primary">
      {{ error }}
    </p>
  </div>
</template>
