<script setup lang="ts">
import { onMounted, reactive } from 'vue';
import { useI18n } from 'vue-i18n';

import { api } from '../../api/client.js';
import { registerOfficeMessages } from '../../office/i18n/index.js';
import { officeMessage } from '../../office/messages.js';

type Status = 'checking' | 'ready' | 'pending' | 'failed';

registerOfficeMessages();

const { t } = useI18n();

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
    <p v-if="state.status === 'checking'">{{ t('office.onboardingStatus.checking') }}</p>
    <p v-else-if="state.status === 'ready'">
      {{ t('office.onboardingStatus.ready') }}
      <a href="/office">{{ t('office.onboardingStatus.dashboardLink') }}</a>
    </p>
    <div v-else-if="state.status === 'pending'">
      <p>{{ t('office.onboardingStatus.pending') }}</p>
      <button type="button" @click="retry">{{ t('office.onboardingStatus.retry') }}</button>
      <p v-if="state.error">{{ state.error }}</p>
    </div>
    <div v-else>
      <p>{{ t('office.onboardingStatus.failed') }}</p>
      <button type="button" @click="retry">{{ t('office.onboardingStatus.retry') }}</button>
      <p v-if="state.error">{{ state.error }}</p>
    </div>
  </div>
</template>
