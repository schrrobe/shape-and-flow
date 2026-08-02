import { computed, useAttrs } from 'vue';

import type { ComputedRef } from 'vue';

/**
 * Moves `data-test` from a field's wrapper onto the control inside it.
 *
 * `<SfInput data-test="email">` means "this is the email field", and a test runner
 * resolving that id expects something it can type into. Vue puts a fallthrough
 * attribute on the component's root element, which for every field here is the
 * `<div>` holding the label, the hint and the error — so the id would resolve to a
 * div, and `fill()` would fail on it.
 *
 * Only the test id is relocated. Everything else a caller passes, `class` above all,
 * belongs to the block: moving it onto the control would restyle every existing form
 * the day this changed.
 */
export function useFieldTestId(): {
  testId: ComputedRef<unknown>;
  wrapperAttrs: ComputedRef<Record<string, unknown>>;
} {
  const attrs = useAttrs();

  return {
    testId: computed(() => attrs['data-test']),
    wrapperAttrs: computed(() => {
      const { 'data-test': _testId, ...rest } = attrs;
      return rest;
    }),
  };
}
