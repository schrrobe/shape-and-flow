<script setup lang="ts">
import { SfButton, SfCard } from '@shape-and-flow/booking-ui';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';

const { t } = useI18n();
const router = useRouter();
</script>

<template>
  <SfCard as="section">
    <h1 class="text-xl font-semibold">{{ t('common.notFoundTitle') }}</h1>
    <p class="mt-2 text-text-secondary">{{ t('common.notFoundBody') }}</p>
    <div class="mt-5">
      <SfButton variant="secondary" @click="router.push({ name: 'home' })">
        {{ t('common.toHome') }}
      </SfButton>
    </div>
  </SfCard>
</template>
