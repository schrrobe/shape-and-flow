<script setup lang="ts">
import { SfCard } from '@shape-and-flow/booking-ui';

import LocaleSwitch from '../../components/LocaleSwitch.vue';
import { useFocusStep } from '../../composables/useFocusStep.js';
import { registerOfficeMessages } from '../../office/i18n/index.js';

/**
 * The chrome the three authentication screens share.
 *
 * They sit outside `OfficeLayout` deliberately: that layout renders a sidebar built from
 * capabilities, and there is no user to build one from yet. Rendering it in a
 * signed-out state would mean a navigation shell whose every link redirects back here.
 */
const props = defineProps<{ heading: string }>();

registerOfficeMessages();
useFocusStep(props.heading);
</script>

<template>
  <div class="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-4 py-10">
    <div class="flex items-center justify-between">
      <p class="text-sm uppercase tracking-widest text-text-secondary">Shape and Flow</p>
      <LocaleSwitch />
    </div>

    <SfCard as="section">
      <h1
        ref="heading"
        tabindex="-1"
        class="text-xl font-semibold tracking-tight outline-none"
        data-test="heading"
      >
        {{ heading }}
      </h1>

      <div class="mt-4 flex flex-col gap-4">
        <slot />
      </div>
    </SfCard>

    <p class="text-sm text-text-secondary">
      <slot name="footer" />
    </p>
  </div>
</template>
