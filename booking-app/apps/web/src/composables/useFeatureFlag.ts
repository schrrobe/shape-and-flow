import { computed, inject, type ComputedRef } from 'vue';

import { FEATURE_FLAG_CLIENT } from '../feature-flags/client.js';

export function useFeatureFlag(name: string, fallback = false): ComputedRef<boolean> {
  const client = inject(FEATURE_FLAG_CLIENT, null);

  return computed(() => {
    if (!client) return fallback;
    // Reading the revision registers SDK update events as a computed dependency.
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    client.version.value;
    if (!client.ready.value) return fallback;
    return client.isEnabled(name, fallback);
  });
}
