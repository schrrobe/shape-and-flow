import { onBeforeUnmount, ref } from 'vue';

import { messageKeyFor } from '../api/errors.js';

/**
 * Load something once, with the three states a screen actually needs.
 *
 * Written out rather than pulled from a data library because the interesting part is small and
 * specific: an in-flight request is aborted when the component goes away, so a customer who taps
 * through three services does not get the first response painted over the third, and an abort is
 * never rendered as an error.
 */
export function useAsyncData<T>(load: (signal: AbortSignal) => Promise<T>) {
  const data = ref<T | null>(null);
  const errorKey = ref<string | null>(null);
  const loading = ref(false);

  let controller: AbortController | null = null;

  async function run(): Promise<void> {
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;

    loading.value = true;
    errorKey.value = null;

    try {
      const result = await load(signal);
      // A late response from a superseded request must not overwrite the current one.
      if (signal.aborted) return;
      data.value = result;
    } catch (error) {
      if (signal.aborted || (error as Error).name === 'AbortError') return;
      errorKey.value = messageKeyFor(error);
    } finally {
      if (!signal.aborted) loading.value = false;
    }
  }

  onBeforeUnmount(() => {
    controller?.abort();
  });

  return { data, errorKey, loading, run };
}
