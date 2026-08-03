<script setup lang="ts">
/**
 * A surface. `as` exists so a card can be a `section` or an `li` where the document structure
 * calls for one — a page of `div`s is a page with no landmarks.
 */
withDefaults(defineProps<{ as?: 'div' | 'section' | 'li' | 'article'; padded?: boolean }>(), {
  as: 'div',
  padded: true,
});
</script>

<template>
  <component
    :is="as"
    class="rounded-sf border border-border bg-surface shadow-card"
    :class="padded ? 'p-4 sm:p-5' : ''"
  >
    <slot />
  </component>
</template>
