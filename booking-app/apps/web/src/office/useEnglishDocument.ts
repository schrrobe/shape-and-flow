import { onBeforeUnmount, onMounted } from 'vue';

import { useLocaleStore } from '../stores/locale.js';

/**
 * Hold `<html lang>` at English while an office screen is on screen.
 *
 * The customer side owns that attribute through `applyLocale`, and it will have set it
 * to `de` for a first-time visitor before anybody reaches the office area. Leaving it
 * there would have a screen reader pronounce English staff copy with German phonetics,
 * which is the specific bug the attribute exists to prevent.
 *
 * Restored on unmount rather than left at `en`, because navigating from the office area
 * back to a customer page is one click and the mistake would then be the mirror image.
 */
export function useEnglishDocument(): void {
  const locale = useLocaleStore();

  onMounted(() => {
    document.documentElement.lang = 'en';
  });

  onBeforeUnmount(() => {
    document.documentElement.lang = locale.current;
  });
}
