<script setup lang="ts">
import { SfIcon } from '@shape-and-flow/booking-ui';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

/**
 * One tap to reach the business.
 *
 * The most common thing a customer wants after booking is to ask something, and for this kind of
 * business that conversation happens on WhatsApp rather than by email. The reference is prefilled so
 * the office does not have to ask "which appointment?" first.
 */
const props = withDefaults(
  defineProps<{
    /** As configured, in any human format. `null` when the business has no WhatsApp. */
    number: string | null;
    reference?: string | null;
  }>(),
  { reference: null },
);

const { t } = useI18n();

/**
 * `wa.me` needs digits only — no `+`, no spaces, no dashes.
 *
 * A number copied from a letterhead has all three, and `wa.me/+49 151 …` silently opens a broken
 * chat rather than failing visibly.
 */
const digits = computed(() => (props.number ?? '').replace(/\D/g, ''));

const href = computed(() => {
  const text = t('manage.whatsappPrefill', { reference: props.reference ?? '' });
  return `https://wa.me/${digits.value}?text=${encodeURIComponent(text)}`;
});
</script>

<template>
  <!-- Nothing at all when there is no number: a dead link to wa.me is worse than no button. -->
  <a
    v-if="digits !== ''"
    :href="href"
    target="_blank"
    rel="noopener noreferrer"
    :aria-label="t('manage.whatsappAria')"
    class="inline-flex items-center gap-2 rounded-sf border border-border bg-surface px-4 py-2.5 font-medium hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
  >
    <SfIcon name="whatsapp" size="lg" />
    {{ t('manage.whatsapp') }}
  </a>
</template>
