<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';

import SfButton from './SfButton.vue';

/**
 * A modal dialog that behaves like one.
 *
 * Three obligations, all of them things a `div` with `position: fixed` does not do:
 *
 *  - **Focus goes in and stays in.** Tab from the last control returns to the first, and
 *    Shift+Tab from the first goes to the last. Without this, tabbing walks into the page
 *    behind the overlay, which a sighted mouse user never notices and a keyboard user cannot
 *    escape.
 *  - **Escape closes it.** Expected everywhere, and the only exit that does not require
 *    finding a button.
 *  - **Focus returns to whatever opened it.** Otherwise focus lands back at the top of the
 *    document and the reader has to find their place again.
 *
 * `native <dialog>` would give some of this, but not the confirm/cancel semantics this app
 * needs, and its backdrop cannot be styled from tokens.
 */
const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    confirmLabel?: string;
    cancelLabel?: string;
    confirmVariant?: 'primary' | 'danger';
    busy?: boolean;
  }>(),
  {
    confirmLabel: 'OK',
    cancelLabel: 'Cancel',
    confirmVariant: 'primary',
    busy: false,
  },
);

const emit = defineEmits<{ close: []; confirm: [] }>();

const titleId = useId();
const panel = ref<HTMLElement | null>(null);

/** What had focus when the dialog opened, so it can be given back. */
let previouslyFocused: HTMLElement | null = null;

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

function focusable(): HTMLElement[] {
  return [...(panel.value?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopPropagation();
    emit('close');
    return;
  }

  if (event.key !== 'Tab') return;

  const elements = focusable();
  const first = elements[0];
  const last = elements.at(-1);
  if (first === undefined || last === undefined) return;

  // Only the two edges need intervening on; everything between them is the browser's job.
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

watch(
  () => props.open,
  async (open) => {
    if (open) {
      previouslyFocused = document.activeElement as HTMLElement | null;
      await nextTick();
      (focusable()[0] ?? panel.value)?.focus();
      return;
    }

    previouslyFocused?.focus();
    previouslyFocused = null;
  },
);

onBeforeUnmount(() => {
  // Unmounting while open — a route change, a parent re-render — must not strand focus.
  if (props.open) previouslyFocused?.focus();
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex items-end justify-center bg-text-primary/40 p-0 sm:items-center sm:p-4"
      @keydown="onKeydown"
    >
      <!-- The backdrop closes on click; the panel stops the click so an in-panel click does
           not. `mousedown` rather than `click`, so a drag that ends outside does not close. -->
      <div class="absolute inset-0" @mousedown="emit('close')"></div>

      <div
        ref="panel"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        tabindex="-1"
        class="relative w-full max-w-lg rounded-sf border border-border bg-surface p-5 shadow-card sm:w-auto sm:min-w-[24rem]"
      >
        <h2 :id="titleId" class="text-lg font-semibold text-text-primary">{{ title }}</h2>

        <div class="mt-3 text-text-primary"><slot /></div>

        <!-- Named here rather than by every caller: a dialog's two buttons mean the same
             thing wherever it is opened, only one dialog is ever open, and a test that
             matched them by their label would break on a copy change or a locale. -->
        <div class="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <SfButton
            variant="secondary"
            data-test="modal-dismiss"
            :disabled="busy"
            @click="emit('close')"
          >
            {{ cancelLabel }}
          </SfButton>
          <SfButton
            data-test="confirm"
            :variant="confirmVariant"
            :loading="busy"
            @click="emit('confirm')"
          >
            {{ confirmLabel }}
          </SfButton>
        </div>
      </div>
    </div>
  </Teleport>
</template>
