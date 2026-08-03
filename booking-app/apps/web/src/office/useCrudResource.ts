import { onMounted, ref } from 'vue';

import { officeMessage } from './messages.js';

import type { ApiError } from '../api/errors.js';
import type { Ref } from 'vue';

/**
 * List, create, edit, archive — once, for the eight management screens.
 *
 * Without this each screen invents its own four-state machine, and the fourth one
 * forgets to reload after an archive or leaves the error from the last attempt on the
 * screen after a successful one. The state here is deliberately small: what is on
 * screen, whether something is in flight, and the last failure.
 *
 * Like every office mutation it is **not optimistic**: `save` calls, reloads and only
 * then resolves. See `useOfficeAction` for why.
 */
export interface CrudResource<Item> {
  items: Ref<Item[]>;
  loading: Ref<boolean>;
  saving: Ref<boolean>;
  error: Ref<string | null>;
  /** The structured `details` of the last failure, for a screen that can say more. */
  errorDetails: Ref<unknown>;
  reload: () => Promise<void>;
  save: (write: () => Promise<unknown>) => Promise<boolean>;
  /**
   * The same thing, handing back what the write answered.
   *
   * `save` returning a boolean is enough for most screens, but not for the ones whose
   * response carries something to render — the working-hours replacement returns the
   * appointments it just stranded. Capturing that into an outer variable from inside the
   * callback defeats TypeScript's narrowing, so it is returned instead.
   */
  saveWith: <Result>(write: () => Promise<Result>) => Promise<Result | null>;
  clearError: () => void;
}

export function useCrudResource<Item>(
  load: () => Promise<{ items: Item[] }>,
  options: { immediate?: boolean } = {},
): CrudResource<Item> {
  const items = ref<Item[]>([]) as Ref<Item[]>;
  const loading = ref(false);
  const saving = ref(false);
  const error = ref<string | null>(null);
  const errorDetails = ref<unknown>(null);

  async function reload(): Promise<void> {
    loading.value = true;

    try {
      items.value = (await load()).items;
    } catch (caught) {
      error.value = officeMessage(caught);
      errorDetails.value = (caught as ApiError).details ?? null;
    } finally {
      loading.value = false;
    }
  }

  async function saveWith<Result>(write: () => Promise<Result>): Promise<Result | null> {
    if (saving.value) return null;

    saving.value = true;
    error.value = null;
    errorDetails.value = null;

    try {
      const result = await write();
      await reload();
      return result;
    } catch (caught) {
      error.value = officeMessage(caught);
      // Kept, because a refusal is often quantitative — "three appointments are in the
      // way" — and the count is in `details` rather than in the message.
      errorDetails.value = (caught as ApiError).details ?? null;
      return null;
    } finally {
      saving.value = false;
    }
  }

  /**
   * Did it go through?
   *
   * A boolean rather than the result, because a write that answers `204` has nothing to
   * return and `undefined` would read as a failure at every call site.
   */
  async function save(write: () => Promise<unknown>): Promise<boolean> {
    return (
      (await saveWith(async () => {
        await write();
        return true;
      })) === true
    );
  }

  function clearError(): void {
    error.value = null;
    errorDetails.value = null;
  }

  if (options.immediate !== false) onMounted(reload);

  return { items, loading, saving, error, errorDetails, reload, save, saveWith, clearError };
}

/** The `bookingCount` an archive refusal carries, when it carried one. */
export function blockingBookingCount(details: unknown): number | null {
  if (details === null || typeof details !== 'object') return null;

  const count = (details as { bookingCount?: unknown }).bookingCount;
  return typeof count === 'number' ? count : null;
}

/** The `serviceCount` a category refusal carries. */
export function blockingServiceCount(details: unknown): number | null {
  if (details === null || typeof details !== 'object') return null;

  const count = (details as { serviceCount?: unknown }).serviceCount;
  return typeof count === 'number' ? count : null;
}
