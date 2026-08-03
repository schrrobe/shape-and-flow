/**
 * The UI package's whole surface.
 *
 * Components are exported here rather than imported by path, so the set is enumerable: a
 * screen cannot reach for a component that is not part of the system, and adding one is a
 * visible change to this file.
 */
export { default as SfAlert } from './components/SfAlert.vue';
export { default as SfBadge } from './components/SfBadge.vue';
export { default as SfButton } from './components/SfButton.vue';
export { default as SfCard } from './components/SfCard.vue';
export { default as SfIcon } from './components/SfIcon.vue';
export { default as SfInput } from './components/SfInput.vue';
export { default as SfModal } from './components/SfModal.vue';
export { default as SfSelect } from './components/SfSelect.vue';
export { default as SfSkeleton } from './components/SfSkeleton.vue';
export { default as SfSpinner } from './components/SfSpinner.vue';
export { default as SfTextarea } from './components/SfTextarea.vue';

export { ICON_PATHS } from './icon-paths.js';
export type { IconData, IconName } from './icon-paths.js';
