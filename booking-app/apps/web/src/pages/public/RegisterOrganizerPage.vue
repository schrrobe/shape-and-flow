<script setup lang="ts">
import { SfInput, SfSelect } from '@shape-and-flow/booking-ui';
import { computed, reactive } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';

import { api } from '../../api/client.js';
import { messageKeyFor } from '../../api/errors.js';

const { t } = useI18n();
const router = useRouter();

const form = reactive({
  entityType: 'INDIVIDUAL',
  displayName: '',
  companyName: '',
  email: '',
  password: '',
  firstName: '',
  lastName: '',
  contactPhone: '',
  addressLine1: '',
  postalCode: '',
  city: '',
  country: 'DE',
  isSmallBusiness: false,
});

const error = reactive<{ key: string | null }>({ key: null });
const submitting = reactive<{ value: boolean }>({ value: false });

const needsCompanyName = computed(() => form.entityType !== 'INDIVIDUAL');
const needsOwnerName = computed(() => form.entityType !== 'ORGANIZATION');

async function onSubmit(): Promise<void> {
  error.key = null;
  submitting.value = true;

  try {
    const body = {
      entityType: form.entityType,
      displayName: form.displayName,
      email: form.email,
      password: form.password,
      contactPhone: form.contactPhone,
      addressLine1: form.addressLine1,
      postalCode: form.postalCode,
      city: form.city,
      country: form.country,
      isSmallBusiness: form.isSmallBusiness,
      ...(needsCompanyName.value ? { companyName: form.companyName } : {}),
      ...(needsOwnerName.value ? { firstName: form.firstName, lastName: form.lastName } : {}),
    };

    const result = await api.public.registerOrganization(
      body as Parameters<typeof api.public.registerOrganization>[0],
    );

    if (result.onboardingLink) {
      window.location.href = result.onboardingLink;
    } else {
      // The organization and owner are already created and the owner is already logged
      // in (the Set-Cookie from this same response) — only the Stripe call failed. The
      // onboarding-status page is where that retry lives, so send them there rather than
      // leaving the form sitting on a response with nothing to show for it.
      await router.push({ name: 'onboarding-status' });
    }
  } catch (caught) {
    error.key = messageKeyFor(caught);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <form class="mx-auto flex max-w-md flex-col gap-4 p-6" @submit.prevent="onSubmit">
    <SfSelect
      v-model="form.entityType"
      data-test="entity-type"
      :label="t('register.entityType')"
      :options="[
        { value: 'INDIVIDUAL', label: t('register.entityTypeIndividual') },
        { value: 'SOLE_PROPRIETORSHIP', label: t('register.entityTypeSoleProprietorship') },
        { value: 'ORGANIZATION', label: t('register.entityTypeOrganization') },
      ]"
      required
    />
    <SfInput
      v-model="form.displayName"
      data-test="display-name"
      :label="t('register.displayName')"
      required
    />
    <SfInput
      v-if="needsCompanyName"
      v-model="form.companyName"
      data-test="company-name"
      :label="t('register.companyName')"
      required
    />
    <SfInput v-model="form.email" data-test="email" type="email" :label="t('register.email')" required />
    <SfInput
      v-model="form.password"
      data-test="password"
      type="password"
      :label="t('register.password')"
      required
    />
    <SfInput
      v-if="needsOwnerName"
      v-model="form.firstName"
      data-test="first-name"
      :label="t('register.firstName')"
      required
    />
    <SfInput
      v-if="needsOwnerName"
      v-model="form.lastName"
      data-test="last-name"
      :label="t('register.lastName')"
      required
    />
    <SfInput
      v-model="form.contactPhone"
      data-test="contact-phone"
      type="tel"
      :label="t('register.contactPhone')"
      required
    />
    <SfInput
      v-model="form.addressLine1"
      data-test="address-line-1"
      :label="t('register.addressLine1')"
      required
    />
    <SfInput
      v-model="form.postalCode"
      data-test="postal-code"
      :label="t('register.postalCode')"
      required
    />
    <SfInput v-model="form.city" data-test="city" :label="t('register.city')" required />
    <p v-if="error.key" class="text-sm font-medium text-text-primary">{{ t(error.key) }}</p>
    <button type="submit" :disabled="submitting.value" class="rounded-sf bg-primary px-4 py-2.5 text-white">
      {{ t('register.submit') }}
    </button>
  </form>
</template>
