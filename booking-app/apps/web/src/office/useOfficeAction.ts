import { ref } from 'vue';

import { officeMessage } from './messages.js';

/**
 * Run one office mutation: disable, call, refetch.
 *
 * **No optimistic updates anywhere in the office area.** A `409` is a normal outcome
 * here — somebody else took the slot, somebody else decided the request first — and a
 * rolled-back optimistic update is more confusing than a spinner that lasted half a
 * second. The operator watches the screen change once, in the direction it actually went.
 *
 * The refetch is not optional and not the caller's to forget: a refused conflict has to
 * leave the screen showing the *current* state, or the next click is made against data
 * the server already disagreed with.
 */
export function useOfficeAction(refetch: () => Promise<void>) {
  const busy = ref(false);
  const error = ref<string | null>(null);

  async function run(action: () => Promise<unknown>): Promise<boolean> {
    if (busy.value) return false;

    busy.value = true;
    error.value = null;

    try {
      await action();
      await refetch();
      return true;
    } catch (caught) {
      error.value = officeMessage(caught);
      // Refetched on failure too. A 409 means the server's state moved, and that is
      // exactly the moment the screen must stop showing what it thought was true.
      await refetch().catch(() => undefined);
      return false;
    } finally {
      busy.value = false;
    }
  }

  function clearError(): void {
    error.value = null;
  }

  return { busy, error, run, clearError };
}
