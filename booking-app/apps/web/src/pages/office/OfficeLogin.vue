<script setup lang="ts">
import { SfAlert, SfButton, SfInput } from '@shape-and-flow/booking-ui';
import { ref } from 'vue';
import { useRouter } from 'vue-router';

import { ApiError } from '../../api/client.js';
import OfficeAuthCard from '../../components/office/OfficeAuthCard.vue';
import { officeMessage } from '../../office/messages.js';
import { useSession } from '../../stores/session.js';

const router = useRouter();
const session = useSession();

const email = ref('');
const password = ref('');
const submitting = ref(false);
const failed = ref(false);
/** Set only for failures that are *not* about the credential — a 429, a dead server. */
const problem = ref<string | null>(null);

/**
 * One message for every way a credential can be unacceptable.
 *
 * Unknown address, wrong password, archived account, locked account — the API answers all
 * four with the same `UNAUTHENTICATED`, on purpose, because a form that distinguishes them
 * is an account-enumeration oracle. Saying more here than the API does would give that
 * back after the server went to the trouble of withholding it.
 */
const GENERIC_FAILURE = 'Those details were not accepted.';

async function submit(): Promise<void> {
  submitting.value = true;
  failed.value = false;
  problem.value = null;

  try {
    const target = await session.login(email.value.trim(), password.value);

    // The route the guard remembered, or the office root. `replace` rather than `push`, so
    // Back does not return to a login form for a session that now exists.
    await router.replace(target ?? '/office');
  } catch (error) {
    password.value = '';

    // A rate limit or an unreachable server is not a rejected credential, and telling
    // somebody their password is wrong when the server never saw it wastes their time.
    if (error instanceof ApiError && error.status === 401) failed.value = true;
    else problem.value = officeMessage(error);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <OfficeAuthCard heading="Sign in">
    <SfAlert v-if="session.expired" tone="info" title="Session ended">
      You were signed out after a period of inactivity. Sign in to carry on where you left off.
    </SfAlert>

    <SfAlert v-if="failed" tone="danger" title="Sign-in failed" data-test="failed">
      {{ GENERIC_FAILURE }}
    </SfAlert>

    <SfAlert v-if="problem !== null" tone="warning" title="Could not sign in" data-test="problem">
      {{ problem }}
    </SfAlert>

    <form class="flex flex-col gap-4" @submit.prevent="submit">
      <SfInput
        v-model="email"
        data-test="email"
        label="Email"
        type="email"
        autocomplete="username"
        required
        :maxlength="320"
      />

      <SfInput
        v-model="password"
        data-test="password"
        label="Password"
        type="password"
        autocomplete="current-password"
        required
        :maxlength="200"
      />

      <SfButton
        type="submit"
        data-test="sign-in"
        :loading="submitting"
        loading-label="Signing in"
        block
      >
        Sign in
      </SfButton>
    </form>

    <template #footer>
      <RouterLink
        :to="{ name: 'office-forgot-password' }"
        class="rounded-sf underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        Forgotten your password?
      </RouterLink>
    </template>
  </OfficeAuthCard>
</template>
