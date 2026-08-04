<script setup lang="ts">
import { SfCard } from '@shape-and-flow/booking-ui';
import { computed, onMounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';

import { STEPS, useBookingDraft } from '../../stores/booking-draft.js';

import type { Step } from '../../stores/booking-draft.js';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const draft = useBookingDraft();

/**
 * Which step the indicator highlights.
 *
 * The checkout page is past the last step rather than before the first, so it keeps `details`
 * highlighted. Falling back to `service` — as the obvious `includes` check does — showed step 1 as
 * current while the customer was looking at their reservation, which reads as having been thrown
 * back to the beginning.
 */
const current = computed<Step>(() => {
  const step = String(route.name ?? '').replace('booking-', '');

  if ((STEPS as string[]).includes(step)) return step as Step;

  return step === 'checkout' ? 'details' : 'service';
});

const index = computed(() => STEPS.indexOf(current.value) + 1);

/**
 * The indicator as navigation: a cleared step is a link back to it.
 *
 * The rule is `canReach`, which is the same one `enforceReachable` applies to a deep link — so the
 * indicator offers exactly the navigation the router would honour. A link to a step whose
 * prerequisites are missing would be redirected straight back, which reads as a broken control:
 * standing on `slot` with no time picked, "Ihre Daten" has nothing to show.
 *
 * The current step is not a link to itself, and checkout offers none at all: a reservation is held
 * and a payment page is open there, so going back to change the service would strand both.
 */
const entries = computed(() =>
  STEPS.map((step, position) => {
    const isCurrent = step === current.value;
    const navigable =
      !isCurrent && String(route.name) !== 'booking-checkout' && draft.canReach(step);

    return {
      step,
      position,
      isCurrent,
      reachable: draft.canReach(step),
      label: t(`booking.step${step.charAt(0).toUpperCase()}${step.slice(1)}`),
      to: navigable ? { name: `booking-${step}` } : null,
    };
  }),
);

/**
 * Keep the URL and the draft in agreement.
 *
 * A deep link or a back button can land on a step whose prerequisites are gone — a bookmarked
 * `/booking/slot` with no service selected has nothing to load. Redirecting to the furthest
 * reachable step is better than rendering an empty panel or an error.
 */
function enforceReachable(): void {
  // The checkout page guards itself: it needs a reservation in memory, which `canReach` knows
  // nothing about.
  if (String(route.name) === 'booking-checkout') return;

  if (draft.canReach(current.value)) return;

  void router.replace({ name: `booking-${draft.furthestReachable()}` });
}

onMounted(() => {
  draft.begin();
  enforceReachable();
});

watch(current, enforceReachable);
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- A list, not a row of divs: the steps are an ordered sequence and a screen reader should
         hear how many there are. -->
    <nav :aria-label="t('booking.stepOf', { current: index, total: STEPS.length })">
      <ol class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-secondary">
        <li
          v-for="entry in entries"
          :key="entry.step"
          :aria-current="entry.isCurrent ? 'step' : undefined"
        >
          <!-- A link only where there is somewhere to go. The alternative — a link on every step,
               disabled by CSS — is a focusable control that answers nothing, and a step ahead of
               the customer would bounce off `enforceReachable` on arrival. -->
          <component
            :is="entry.to === null ? 'span' : 'RouterLink'"
            :to="entry.to ?? undefined"
            class="flex items-center gap-2 rounded-full"
            :class="
              entry.to === null
                ? ''
                : 'hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary'
            "
            :data-test="`step-${entry.step}`"
          >
            <span
              class="rounded-full px-2 py-0.5"
              :class="
                entry.isCurrent
                  ? 'bg-primary font-semibold text-primary-contrast'
                  : entry.reachable
                    ? 'bg-surface-muted'
                    : 'bg-surface-muted opacity-60'
              "
            >
              {{ entry.position + 1 }}
            </span>
            <span :class="entry.isCurrent ? 'font-semibold text-text-primary' : ''">
              {{ entry.label }}
            </span>
          </component>
        </li>
      </ol>
    </nav>

    <SfCard as="section">
      <RouterView />
    </SfCard>
  </div>
</template>
