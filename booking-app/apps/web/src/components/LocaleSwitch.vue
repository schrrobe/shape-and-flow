<script setup lang="ts">
import { useI18n } from 'vue-i18n';

import { LOCALES } from '../i18n/index.js';
import { useLocaleStore } from '../stores/locale.js';

import type { Locale } from '../i18n/index.js';

const { t } = useI18n();
const locale = useLocaleStore();

/** A group of buttons rather than a select: two options, one tap, no menu to open. */
function labelFor(value: Locale): string {
  return value === 'de' ? t('common.german') : t('common.english');
}
</script>

<template>
  <div class="flex items-center gap-1" role="group" :aria-label="t('common.language')">
    <button
      v-for="value in LOCALES"
      :key="value"
      type="button"
      :data-test="`locale-${value}`"
      :lang="value"
      :aria-current="locale.current === value ? 'true' : undefined"
      class="rounded-sf px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      :class="
        locale.current === value
          ? 'bg-surface-muted font-semibold text-text-primary'
          : 'text-text-secondary hover:bg-surface-muted'
      "
      @click="locale.set(value)"
    >
      <!-- The full name, not a flag: a flag is a country, and a language is not. -->
      {{ labelFor(value) }}
    </button>
  </div>
</template>
