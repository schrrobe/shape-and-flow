<script setup lang="ts">
import { SfAlert, SfButton, SfInput } from '@shape-and-flow/booking-ui';
import { ref } from 'vue';

import { api } from '../../api/client.js';
import OfficeAuthCard from '../../components/office/OfficeAuthCard.vue';
import { officeMessage } from '../../office/messages.js';

const email = ref('');
const submitting = ref(false);
const sent = ref(false);
const problem = ref<string | null>(null);

/**
 * The confirmation says nothing about whether the address exists.
 *
 * The API answers `202` either way — it will not confirm which addresses have accounts —
 * and a screen that said "no such user" would undo that. So the wording describes what
 * happens *if* there is an account, which is both honest and useless to somebody probing.
 */
async function submit(): Promise<void> {
  submitting.value = true;
  problem.value = null;

  try {
    await api.auth.requestPasswordReset({ email: email.value.trim() });
    sent.value = true;
  } catch (error) {
    // A 429 is the one worth surfacing: five attempts an hour, and somebody who hit it
    // needs to be told to wait rather than left pressing a button that does nothing.
    problem.value = officeMessage(error);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <OfficeAuthCard heading="Reset your password">
    <SfAlert v-if="sent" tone="success" title="Check your inbox" data-test="sent">
      If an account exists for that address, a reset link is on its way. The link is valid for one
      hour and can be used once.
    </SfAlert>

    <template v-else>
      <SfAlert v-if="problem !== null" tone="warning" title="Could not send the link">
        {{ problem }}
      </SfAlert>

      <p class="text-text-secondary">
        Enter the address you sign in with and we will send you a link to set a new password.
      </p>

      <form class="flex flex-col gap-4" @submit.prevent="submit">
        <SfInput
          v-model="email"
          label="Email"
          type="email"
          autocomplete="username"
          required
          :maxlength="320"
        />

        <SfButton type="submit" :loading="submitting" loading-label="Sending" block>
          Send the link
        </SfButton>
      </form>
    </template>

    <template #footer>
      <RouterLink
        :to="{ name: 'office-login' }"
        class="rounded-sf underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        Back to sign in
      </RouterLink>
    </template>
  </OfficeAuthCard>
</template>
