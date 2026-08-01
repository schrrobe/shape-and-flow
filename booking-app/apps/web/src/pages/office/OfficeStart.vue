<script setup lang="ts">
import { SfCard } from '@shape-and-flow/booking-ui';

import { useFocusStep } from '../../composables/useFocusStep.js';
import { useSession } from '../../stores/session.js';

/**
 * The office landing page.
 *
 * A deviation from the plan, and a deliberate one: task 10.1 has to have a route behind the
 * session guard to guard, and the dashboard it eventually lands on belongs to 10.2. Rather
 * than guard a route whose component does not exist, `/office` shows who is signed in.
 *
 * It is registered under the name `office-dashboard`, so task 10.2 swaps the component and
 * nothing else moves — not the path, not the sidebar entry, not any link.
 */
const session = useSession();

useFocusStep('Office');
</script>

<template>
  <SfCard as="section">
    <h1 ref="heading" tabindex="-1" class="text-xl font-semibold tracking-tight outline-none">
      Office
    </h1>

    <p class="mt-2 text-text-secondary" data-test="greeting">
      Signed in as {{ session.displayName }}. Your role is {{ session.role }}.
    </p>

    <p v-if="session.employeeId !== null" class="mt-2 text-text-secondary">
      This account is linked to a person on the calendar, so it sees its own appointments.
    </p>
  </SfCard>
</template>
