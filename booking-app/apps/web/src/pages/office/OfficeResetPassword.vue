<script setup lang="ts">
import { MIN_PASSWORD_LENGTH, newPasswordSchema } from '@shape-and-flow/booking-contracts';
import { SfAlert, SfButton, SfInput } from '@shape-and-flow/booking-ui';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';

import { api } from '../../api/client.js';
import OfficeAuthCard from '../../components/office/OfficeAuthCard.vue';
import { useFragmentCredential } from '../../composables/useFragmentCredential.js';
import { registerOfficeMessages } from '../../office/i18n/index.js';
import { officeMessage } from '../../office/messages.js';

registerOfficeMessages();

const { t } = useI18n();

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
      ? t('office.resetPassword.tooShort', { min: MIN_PASSWORD_LENGTH })
      : t('office.resetPassword.tooCommon');
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
  <OfficeAuthCard :heading="t('office.resetPassword.heading')">
    <SfAlert
      v-if="missing"
      tone="warning"
      :title="t('office.resetPassword.missingTitle')"
      data-test="missing"
    >
      {{ t('office.resetPassword.missingBody') }}
    </SfAlert>

    <SfAlert
      v-else-if="done"
      tone="success"
      :title="t('office.resetPassword.doneTitle')"
      data-test="done"
    >
      {{ t('office.resetPassword.doneBody') }}
    </SfAlert>

    <template v-else>
      <SfAlert
        v-if="problem !== null"
        tone="danger"
        :title="t('office.resetPassword.problemTitle')"
      >
        {{ problem }}
      </SfAlert>

      <p class="text-text-secondary">
        {{ t('office.resetPassword.instructions', { min: MIN_PASSWORD_LENGTH }) }}
      </p>

      <form class="flex flex-col gap-4" @submit.prevent="submit">
        <SfInput
          v-model="password"
          :label="t('office.resetPassword.passwordLabel')"
          type="password"
          autocomplete="new-password"
          required
          :maxlength="200"
          :error="passwordProblem"
        />

        <SfInput
          v-model="confirmation"
          :label="t('office.resetPassword.confirmationLabel')"
          type="password"
          autocomplete="new-password"
          required
          :maxlength="200"
          :error="mismatch ? t('office.resetPassword.mismatch') : null"
        />

        <SfButton
          type="submit"
          :loading="submitting"
          :disabled="!ready"
          :loading-label="t('office.resetPassword.savingLabel')"
          block
        >
          {{ t('office.resetPassword.submitLabel') }}
        </SfButton>
      </form>
    </template>

    <template #footer>
      <RouterLink
        :to="{ name: 'office-login' }"
        class="rounded-sf underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        {{ t('office.resetPassword.backToSignIn') }}
      </RouterLink>
    </template>
  </OfficeAuthCard>
</template>
