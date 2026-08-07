<script setup lang="ts">
import { onMounted, reactive } from 'vue';

import { api } from '../../api/client.js';
import { officeMessage } from '../../office/messages.js';

type Status = 'checking' | 'ready' | 'pending' | 'failed';

const state = reactive<{ status: Status; error: string | null }>({
  status: 'checking',
  error: null,
});

onMounted(async () => {
  try {
    const organization = await api.office.organization.current();
    state.status = organization.stripeChargesEnabled ? 'ready' : 'pending';
  } catch {
    state.status = 'failed';
  }
});

async function retry(): Promise<void> {
  state.error = null;
  try {
    const { onboardingLink } = await api.office.organization.requestOnboardingLink();
    window.location.href = onboardingLink;
  } catch (caught) {
    state.error = officeMessage(caught);
  }
}
</script>

<template>
  <div class="mx-auto flex max-w-md flex-col gap-4 p-6">
    <p v-if="state.status === 'checking'">Checking your Stripe onboarding status…</p>
    <p v-else-if="state.status === 'ready'">Your account is ready. <a href="/office">Go to the dashboard</a>.</p>
    <p v-else-if="state.status === 'pending'">
      Stripe is still processing your details. Reload this page in a minute.
    </p>
    <div v-else>
      <p>Something went wrong finishing your Stripe onboarding.</p>
      <button type="button" @click="retry">Retry onboarding</button>
      <p v-if="state.error">{{ state.error }}</p>
    </div>
  </div>
</template>
