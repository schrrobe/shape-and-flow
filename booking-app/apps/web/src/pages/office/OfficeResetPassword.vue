<script setup lang="ts">
import { MIN_PASSWORD_LENGTH, newPasswordSchema } from '@shape-and-flow/booking-contracts';
import { SfAlert, SfButton, SfInput } from '@shape-and-flow/booking-ui';
import { computed, ref } from 'vue';

import { api } from '../../api/client.js';
import OfficeAuthCard from '../../components/office/OfficeAuthCard.vue';
import { useFragmentCredential } from '../../composables/useFragmentCredential.js';
import { officeMessage } from '../../office/messages.js';

/**
 * The token arrives in the fragment, not the query string.
 *
 * The plan specifies a query string here; the API sends `/office/reset-password#<token>`. The
 * fragment is the right place and the API is right to use it — a query string would put a live
 * credential in the server's access log and in any `Referer` this page emits — so this follows the
 * API. Recorded as a deviation rather than papered over.
 */
const { token, missing } = useFragmentCredential();

const password = ref('');
const confirmation = ref('');
const submitting = ref(false);
const done = ref(false);
const problem = ref<string | null>(null);

/**
 * The same rule the server applies, imported rather than retyped.
 *
 * `newPasswordSchema` carries the minimum length *and* the deny list. Restating "at least 12
 * characters" as a client-side number would be a second copy that stops matching the day the
 * server's rule changes.
 */
const passwordProblem = computed(() => {
  if (password.value === '') return null;

  const result = newPasswordSchema.safeParse(password.value);
  if (!result.success) {
    return password.value.length < MIN_PASSWORD_LENGTH
      ? `Use at least ${String(MIN_PASSWORD_LENGTH)} characters.`
      : 'That password is too common. Choose another.';
  }

  return null;
});

const mismatch = computed(() => confirmation.value !== '' && confirmation.value !== password.value);

const ready = computed(
  () =>
    token.value !== null &&
    passwordProblem.value === null &&
    password.value !== '' &&
    confirmation.value === password.value,
);

async function submit(): Promise<void> {
  const value = token.value;
  if (value === null || !ready.value) return;

  submitting.value = true;
  problem.value = null;

  try {
    await api.auth.confirmPasswordReset({ token: value, newPassword: password.value });
    done.value = true;
  } catch (error) {
    problem.value = officeMessage(error);
  } finally {
    submitting.value = false;
    // Cleared whatever happened: a failed attempt leaves a password sitting in a field that
    // somebody may walk away from.
    password.value = '';
    confirmation.value = '';
  }
}
</script>

<template>
  <OfficeAuthCard heading="Set a new password">
    <SfAlert v-if="missing" tone="warning" title="Link incomplete" data-test="missing">
      This link is missing its token, or has already been opened. Request a new one.
    </SfAlert>

    <SfAlert v-else-if="done" tone="success" title="Password changed" data-test="done">
      You can sign in with your new password. Any other sessions have been signed out.
    </SfAlert>

    <template v-else>
      <SfAlert v-if="problem !== null" tone="danger" title="Could not set the password">
        {{ problem }}
      </SfAlert>

      <p class="text-text-secondary">
        Choose a password of at least {{ MIN_PASSWORD_LENGTH }} characters, then type it a second
        time to confirm.
      </p>

      <form class="flex flex-col gap-4" @submit.prevent="submit">
        <SfInput
          v-model="password"
          label="New password"
          type="password"
          autocomplete="new-password"
          required
          :maxlength="200"
          :error="passwordProblem"
        />

        <SfInput
          v-model="confirmation"
          label="Repeat the new password"
          type="password"
          autocomplete="new-password"
          required
          :maxlength="200"
          :error="mismatch ? 'The two entries do not match.' : null"
        />

        <SfButton
          type="submit"
          :loading="submitting"
          :disabled="!ready"
          loading-label="Saving"
          block
        >
          Save the password
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
