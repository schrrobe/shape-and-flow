<script setup lang="ts">
import { onMounted } from 'vue';
import { useI18n } from 'vue-i18n';

import LocaleSwitch from './components/LocaleSwitch.vue';
import { useLocaleStore } from './stores/locale.js';

const { t } = useI18n();
const locale = useLocaleStore();

// Resolved here rather than in `main.ts` so the store is the single source of truth and the
// document's `lang` is set from the same place the UI reads.
onMounted(() => {
  locale.initialize();
});
</script>

<template>
  <!--
    A skip link first in the DOM. Every page starts with the same header, and without this a
    keyboard user tabs through it again on every navigation.
  -->
  <a
    href="#main"
    class="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-sf focus:bg-surface focus:px-3 focus:py-2 focus:ring-2 focus:ring-focus-ring"
  >
    {{ t('common.skipToContent') }}
  </a>

  <div class="mx-auto flex min-h-dvh w-full max-w-3xl flex-col px-4 py-6 sm:px-6">
    <header class="mb-6 flex items-baseline justify-between gap-4">
      <RouterLink
        :to="{ name: 'home' }"
        class="rounded-sf text-xl font-semibold tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        Shape and Flow
      </RouterLink>
      <LocaleSwitch />
    </header>

    <main id="main" class="flex-1">
      <RouterView />
    </main>

    <footer class="mt-10 text-sm text-text-secondary">
      <p>{{ t('common.footerNote') }}</p>
    </footer>
  </div>
</template>
