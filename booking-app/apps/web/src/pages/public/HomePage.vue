<script setup lang="ts">
import { SfButton, SfCard, SfIcon } from '@shape-and-flow/booking-ui';
</script>

<template>
  <div class="flex flex-col gap-6">
    <SfCard as="section">
      <h1 class="text-2xl font-semibold tracking-tight">Termin buchen</h1>
      <p class="mt-2 text-text-secondary">
        Wählen Sie eine Behandlung, einen Termin und bezahlen Sie direkt online.
      </p>

      <ul class="mt-4 flex flex-col gap-2 text-sm text-text-secondary">
        <li class="flex items-center gap-2">
          <SfIcon name="calendar" /><span>Freie Termine in Echtzeit</span>
        </li>
        <li class="flex items-center gap-2">
          <SfIcon name="credit-card" /><span>Sichere Zahlung über Stripe</span>
        </li>
        <li class="flex items-center gap-2">
          <SfIcon name="clock" /><span>Absage bis 24 Stunden vorher kostenfrei</span>
        </li>
      </ul>

      <div class="mt-6">
        <SfButton disabled>Behandlung wählen</SfButton>
      </div>
    </SfCard>
  </div>
</template>
