<script setup lang="ts">
import { SfAlert, SfSkeleton } from '@shape-and-flow/booking-ui';
import { loadConnectAndInitialize } from '@stripe/connect-js';
import { nextTick, onBeforeUnmount, onMounted, reactive, useTemplateRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';

import { api } from '../../api/client.js';
import { ApiError } from '../../api/errors.js';
import { registerOfficeMessages } from '../../office/i18n/index.js';
import { officeMessage } from '../../office/messages.js';

/**
 * `onboarding` is not an error: an organizer who has not finished with Stripe has nothing
 * to show here yet, and the fix is a screen we already have rather than a retry.
 */
type Status = 'loading' | 'onboarding' | 'ready' | 'failed';

registerOfficeMessages();

const { t } = useI18n();

const state = reactive<{ status: Status; error: string | null }>({
  status: 'loading',
  error: null,
});

const paymentsSlot = useTemplateRef<HTMLElement>('paymentsSlot');
const payoutsSlot = useTemplateRef<HTMLElement>('payoutsSlot');

function fail(caught: unknown): void {
  state.status = 'failed';
  state.error = officeMessage(caught);
}

onMounted(async () => {
  try {
    // The first secret is fetched here rather than left to Connect.js so that a rejected
    // call surfaces as our error message instead of a silently blank iframe. It is also
    // the one gate on whether this page can work at all: the endpoint refuses with
    // ORGANIZATION_ONBOARDING_INCOMPLETE until the account is onboarded and charges are
    // enabled, so asking the organization endpoint the same question first would be a
    // second round trip and a second copy of the same policy.
    const { publishableKey, clientSecret } = await api.office.payments.createAccountSession();

    // Connect.js calls `fetchClientSecret` immediately. Handing it the secret above rather
    // than letting it open its own session is what keeps one page view to one
    // AccountSession — and to one audit row.
    let unusedSecret: string | null = clientSecret;

    const connect = loadConnectAndInitialize({
      publishableKey,
      // Called again whenever Stripe needs a fresh secret. Deliberately not memoised: an
      // AccountSession secret is single-use, so a cached one fails the second time.
      fetchClientSecret: async () => {
        if (unusedSecret !== null) {
          const secret = unusedSecret;
          unusedSecret = null;
          return secret;
        }

        try {
          const refreshed = await api.office.payments.createAccountSession();
          return refreshed.clientSecret;
        } catch (caught) {
          // Rejecting alone leaves the component blank: this call happens long after the
          // `onMounted` try/catch has returned, so nothing else would report it.
          fail(caught);
          throw caught;
        }
      },
    });

    state.status = 'ready';

    // After the status flip, so the containers the components mount into exist.
    await nextTick();
    paymentsSlot.value?.append(embed(connect, 'payments'));
    payoutsSlot.value?.append(embed(connect, 'payouts'));
  } catch (caught) {
    // Not an error, and not something a retry fixes: the organizer has to finish with
    // Stripe first, and the screen for that is one link away.
    if (caught instanceof ApiError && caught.code === 'ORGANIZATION_ONBOARDING_INCOMPLETE') {
      state.status = 'onboarding';
      return;
    }

    fail(caught);
  }
});

/**
 * A Connect element that reports its own load failures.
 *
 * `loadConnectAndInitialize` returns synchronously and the components fetch and render
 * afterwards, so a blocked script, a rejected key or a render error surfaces here and
 * nowhere else — without this the page would sit at `ready` showing two empty boxes.
 */
function embed(
  connect: ReturnType<typeof loadConnectAndInitialize>,
  tagName: 'payments' | 'payouts',
): HTMLElement {
  const element = connect.create(tagName);

  element.setOnLoadError(() => {
    state.status = 'failed';
    // No message from Stripe: theirs is untranslated prose aimed at an integrator.
    state.error = null;
  });

  return element;
}

// Connect.js owns nodes it appended into our containers; emptying them on the way out
// stops a stale iframe from being adopted by the next mount of this route.
onBeforeUnmount(() => {
  paymentsSlot.value?.replaceChildren();
  payoutsSlot.value?.replaceChildren();
});
</script>

<template>
  <section class="space-y-4">
    <h1 class="text-xl font-semibold tracking-tight">{{ t('office.payments.heading') }}</h1>

    <SfSkeleton v-if="state.status === 'loading'" />

    <SfAlert v-else-if="state.status === 'onboarding'" tone="warning">
      {{ t('office.payments.onboardingRequired') }}
      <RouterLink :to="{ name: 'onboarding-status' }">
        {{ t('office.payments.onboardingLink') }}
      </RouterLink>
    </SfAlert>

    <SfAlert v-else-if="state.status === 'failed'" tone="danger">
      {{ state.error ?? t('office.payments.failed') }}
    </SfAlert>

    <template v-else>
      <p class="text-sm">{{ t('office.payments.intro') }}</p>

      <section class="space-y-2">
        <h2 class="text-lg font-medium">{{ t('office.payments.payoutsHeading') }}</h2>
        <div ref="payoutsSlot" data-test="payouts-component"></div>
      </section>

      <section class="space-y-2">
        <h2 class="text-lg font-medium">{{ t('office.payments.paymentsHeading') }}</h2>
        <div ref="paymentsSlot" data-test="payments-component"></div>
      </section>
    </template>
  </section>
</template>
