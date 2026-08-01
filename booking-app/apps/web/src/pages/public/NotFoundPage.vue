<script setup lang="ts">
import { SfButton, SfCard } from '@shape-and-flow/booking-ui';
import { useRouter } from 'vue-router';

const router = useRouter();
</script>

<template>
  <SfCard as="section">
    <h1 class="text-xl font-semibold">Seite nicht gefunden</h1>
    <p class="mt-2 text-text-secondary">Diese Adresse gibt es nicht oder nicht mehr.</p>
    <div class="mt-5">
      <SfButton variant="secondary" @click="router.push({ name: 'home' })">Zur Startseite</SfButton>
    </div>
  </SfCard>
</template>
