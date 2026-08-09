<script setup lang="ts">
import { SfAlert, SfSkeleton } from '@shape-and-flow/booking-ui';
import { loadConnectAndInitialize } from '@stripe/connect-js';
import { nextTick, onBeforeUnmount, onMounted, reactive, useTemplateRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';

import { api } from '../../api/client.js';
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

onMounted(async () => {
  try {
    const organization = await api.office.organization.current();

    if (!organization.stripeChargesEnabled) {
      state.status = 'onboarding';
      return;
    }

    // The first secret is fetched here rather than left to Connect.js so that a rejected
    // call surfaces as our error message instead of a silently blank iframe.
    const { publishableKey } = await api.office.payments.createAccountSession();

    const connect = loadConnectAndInitialize({
      publishableKey,
      // Called again whenever Stripe needs a fresh secret. Deliberately not memoised: an
      // AccountSession secret is single-use, so a cached one fails the second time.
      fetchClientSecret: async () => {
        const { clientSecret } = await api.office.payments.createAccountSession();
        return clientSecret;
      },
    });

    state.status = 'ready';

    // After the status flip, so the containers the components mount into exist.
    await nextTick();
    paymentsSlot.value?.append(connect.create('payments'));
    payoutsSlot.value?.append(connect.create('payouts'));
  } catch (caught) {
    state.status = 'failed';
    state.error = officeMessage(caught);
  }
});

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
