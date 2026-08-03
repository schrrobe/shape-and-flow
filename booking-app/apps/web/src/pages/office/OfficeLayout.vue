<script setup lang="ts">
import { SfButton } from '@shape-and-flow/booking-ui';
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';

import { NAVIGATION } from '../../office/navigation.js';
import { useEnglishDocument } from '../../office/useEnglishDocument.js';
import { useSession } from '../../stores/session.js';

const router = useRouter();
const session = useSession();

useEnglishDocument();

const signingOut = ref(false);

/**
 * What this user can reach, and what has been built.
 *
 * Two filters, for two different reasons. `can` hides what the API would refuse — a link
 * that 403s is worse than no link. `hasRoute` hides destinations stage 10 has not
 * delivered yet; a `RouterLink` to an unregistered name resolves to the catch-all, which
 * would send a member of staff to the customer-facing 404 page. A test pins exactly which
 * entries are still missing, so the gap shrinks visibly instead of quietly.
 */
const entries = computed(() =>
  NAVIGATION.filter((entry) => router.hasRoute(entry.name) && session.can(entry.capability)),
);

async function signOut(): Promise<void> {
  signingOut.value = true;

  try {
    await session.logout();
  } finally {
    // The store is cleared even when the call failed, so the redirect is right either way.
    signingOut.value = false;
    await router.replace({ name: 'office-login' });
  }
}
</script>

<template>
  <!--
    Its own skip link. The office chrome is a header plus a sidebar of up to eleven links, so
    without one a keyboard user tabs through the whole navigation on every screen.
  -->
  <a
    href="#office-main"
    class="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-sf focus:bg-surface focus:px-3 focus:py-2 focus:ring-2 focus:ring-focus-ring"
  >
    Skip to content
  </a>

  <div class="mx-auto flex min-h-dvh w-full max-w-7xl flex-col px-4 py-4 sm:px-6">
    <header class="flex flex-wrap items-baseline justify-between gap-3 border-b border-border pb-3">
      <p class="text-lg font-semibold tracking-tight">
        Shape and Flow
        <span class="text-text-secondary">Office</span>
      </p>

      <div class="flex items-baseline gap-3 text-sm">
        <span data-test="current-user">
          {{ session.displayName }}
          <span class="text-text-secondary">({{ session.role }})</span>
        </span>

        <SfButton
          variant="ghost"
          :loading="signingOut"
          loading-label="Signing out"
          data-test="sign-out"
          @click="signOut"
        >
          Sign out
        </SfButton>
      </div>
    </header>

    <div class="flex flex-1 flex-col gap-6 pt-4 md:flex-row">
      <nav aria-label="Office sections" class="md:w-48 md:shrink-0">
        <ul class="flex flex-wrap gap-1 md:flex-col">
          <li v-for="entry in entries" :key="entry.name">
            <RouterLink
              :to="{ name: entry.name }"
              class="block rounded-sf px-3 py-2 text-sm hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              active-class="bg-surface-muted font-medium"
              :data-test="`nav-${entry.name}`"
            >
              {{ entry.label }}
            </RouterLink>
          </li>
        </ul>
      </nav>

      <main id="office-main" class="min-w-0 flex-1">
        <RouterView />
      </main>
    </div>
  </div>
</template>
