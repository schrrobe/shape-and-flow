import { nextTick, onMounted, toValue, useTemplateRef, watchEffect } from 'vue';

/** The `ref` attribute every step puts on its heading. A convention, so the composable can bind it. */
const STEP_HEADING_REF = 'heading';

/**
 * Move focus to a step's heading when it opens, and name the page.
 *
 * Without this, navigating between wizard steps leaves focus wherever the previous step's button
 * was — which for a screen-reader user means the new step is never announced, and for a keyboard
 * user means the next Tab continues from the wrong place. The heading carries `tabindex="-1"` so it
 * can take focus programmatically without becoming a tab stop.
 *
 * The element is bound by name through `useTemplateRef` rather than returned for the component to
 * destructure. A returned ref has to be re-exported into the template, and `ref="heading"` is a
 * plain string attribute that TypeScript cannot see as a use of that variable — so the binding
 * looked unused and the compiler was right to say so.
 *
 * The document title is set here too: a router does not change it, and it is the first thing a
 * screen reader reads after a navigation. `title` accepts a getter rather than a plain string so a
 * translated label keeps the title in sync when the operator switches locale mid-session.
 */
export function useFocusStep(title: string | (() => string)): void {
  const heading = useTemplateRef<HTMLElement>(STEP_HEADING_REF);

  watchEffect(() => {
    document.title = `${toValue(title)} — Shape and Flow`;
  });

  onMounted(async () => {
    // After render, or the element does not exist yet.
    await nextTick();
    heading.value?.focus();
  });
}
