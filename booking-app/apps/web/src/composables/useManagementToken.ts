import { useFragmentCredential } from './useFragmentCredential.js';

import type { ComputedRef, Ref } from 'vue';

/**
 * The customer's management token.
 *
 * A named wrapper rather than a second implementation: the office password-reset link needs
 * exactly the same handling, so the mechanics — and the reasoning about why a credential travels
 * in the fragment and does not stay there — live in `useFragmentCredential`.
 */
export function useManagementToken(): {
  token: Ref<string | null>;
  missing: ComputedRef<boolean>;
} {
  return useFragmentCredential();
}
