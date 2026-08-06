<script setup lang="ts">
import { SfAlert, SfButton, SfCard, SfInput, SfSkeleton } from '@shape-and-flow/booking-ui';
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';

import { api } from '../../api/client.js';
import { useFocusStep } from '../../composables/useFocusStep.js';
import { dateTime, difference, money } from '../../office/format.js';
import { registerOfficeMessages } from '../../office/i18n/index.js';
import { officeMessage } from '../../office/messages.js';
import { useSession } from '../../stores/session.js';

import type {
  OfficeCancellationRequest,
  OfficeRescheduleRequest,
} from '@shape-and-flow/booking-contracts';

/**
 * The two queues, and the decisions taken from them.
 *
 * **The refund is previewed before it is sent.** A cancellation decision is expressed as
 * "how much do we keep", and the number that actually leaves the business is the
 * difference — so an operator typing 10 into a field labelled "retain" is one keystroke
 * away from refunding 35 without ever seeing the figure. The preview is what makes the
 * consequence the thing on screen.
 *
 * The retained field is **hidden entirely** without `refund.issue` rather than disabled:
 * an admin who may not move money can still reject a request or approve it retaining
 * everything, and a greyed-out field would suggest the decision is theirs to make.
 */
registerOfficeMessages();

const { t } = useI18n();
const session = useSession();

useFocusStep(t('office.requests.heading'));

const cancellations = ref<OfficeCancellationRequest[]>([]);
const reschedules = ref<OfficeRescheduleRequest[]>([]);
const loading = ref(false);
const busy = ref<string | null>(null);
const error = ref<string | null>(null);
const decided = ref<{ id: string; message: string } | null>(null);

/** Euros typed per request, keyed by request id. */
const retained = ref<Record<string, string>>({});
const notes = ref<Record<string, string>>({});

function toCents(value: string): number | null {
  const normalised = value.trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(normalised)) return null;

  return Math.round(Number(normalised) * 100);
}

/**
 * What the office will keep, as cents.
 *
 * Falls back to the frozen suggestion when the field is untouched — which is the value
 * the customer was shown before they asked, and the one the API uses if the body omits
 * it. Showing one number and sending another would be the worst of both.
 */
function retainedCents(request: OfficeCancellationRequest): number {
  const typed = retained.value[request.id];
  if (typed === undefined || typed.trim() === '') return request.suggestedRetainedAmountCents;

  return toCents(typed) ?? request.suggestedRetainedAmountCents;
}

/** What goes back to the customer, which is what the confirmation has to state. */
function refundCents(request: OfficeCancellationRequest): number {
  return difference(request.booking.paid, {
    amountCents: retainedCents(request),
    currency: request.booking.paid.currency,
  }).amountCents;
}

/** The same rule the API enforces: you cannot keep more than they gave you. */
function retainedValid(request: OfficeCancellationRequest): boolean {
  const typed = retained.value[request.id];
  if (typed === undefined || typed.trim() === '') return true;

  const cents = toCents(typed);
  return cents !== null && cents >= 0 && cents <= request.booking.paid.amountCents;
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;

  // Settled separately rather than through `Promise.all`. The two queues answer to two
  // different capabilities, so one of them being refused is a normal outcome — and an
  // admin who may decide cancellations must still get the cancellation queue when the
  // reschedule call is the one that failed.
  const [cancelResult, rescheduleResult] = await Promise.allSettled([
    session.can('cancellation.decide')
      ? api.office.requests.cancellations({ decision: 'PENDING' })
      : Promise.resolve({ items: [] }),
    session.can('reschedule.decide')
      ? api.office.requests.reschedules({ decision: 'PENDING' })
      : Promise.resolve({ items: [] }),
  ]);

  cancellations.value = cancelResult.status === 'fulfilled' ? cancelResult.value.items : [];
  reschedules.value = rescheduleResult.status === 'fulfilled' ? rescheduleResult.value.items : [];

  // One message for either failure: the operator needs to know a queue is missing, and
  // which of the two calls broke is a detail for the console, not for this alert.
  const refused = [cancelResult, rescheduleResult].find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  error.value = refused === undefined ? null : officeMessage(refused.reason);

  loading.value = false;
}

async function decideCancellation(
  request: OfficeCancellationRequest,
  decision: 'APPROVED' | 'REJECTED',
): Promise<void> {
  if (busy.value !== null || !retainedValid(request)) return;

  busy.value = request.id;
  error.value = null;

  const typed = retained.value[request.id];
  const note = notes.value[request.id];

  try {
    await api.office.requests.decideCancellation(request.id, {
      decision,
      ...(decision === 'APPROVED' && typed !== undefined && typed.trim() !== ''
        ? { retainedAmountCents: retainedCents(request) }
        : {}),
      ...(note === undefined || note.trim() === '' ? {} : { note: note.trim() }),
    });

    decided.value = {
      id: request.id,
      message:
        decision === 'APPROVED'
          ? t('office.requests.cancelledMessage', {
              amount: money(refundCents(request)),
              name: request.booking.customerName,
            })
          : t('office.requests.keptMessage', { name: request.booking.customerName }),
    };
  } catch (caught) {
    error.value = officeMessage(caught);
  } finally {
    busy.value = null;
    await load();
  }
}

async function decideReschedule(
  request: OfficeRescheduleRequest,
  decision: 'APPROVED' | 'REJECTED',
): Promise<void> {
  if (busy.value !== null) return;

  busy.value = request.id;
  error.value = null;

  const note = notes.value[request.id];

  try {
    await api.office.requests.decideReschedule(request.id, {
      decision,
      ...(note === undefined || note.trim() === '' ? {} : { note: note.trim() }),
    });

    decided.value = {
      id: request.id,
      message:
        decision === 'APPROVED'
          ? t('office.requests.movedMessage', { date: dateTime(request.requestedStartsAt) })
          : t('office.requests.leftMessage', { name: request.booking.customerName }),
    };
  } catch (caught) {
    error.value = officeMessage(caught);
  } finally {
    busy.value = null;
    await load();
  }
}

/**
 * Both queues empty, whether or not they have been read yet.
 *
 * The loading flag deliberately stays out of it: the template combines the two, and
 * `loading && empty` — the condition that shows the skeleton — can only ever be true if
 * `empty` says nothing about loading.
 */
const empty = computed(() => cancellations.value.length === 0 && reschedules.value.length === 0);

onMounted(load);
</script>

<template>
  <section class="space-y-4">
    <h1 ref="heading" tabindex="-1" class="text-xl font-semibold tracking-tight outline-none">
      {{ t('office.requests.heading') }}
    </h1>

    <SfAlert v-if="error !== null" tone="danger" data-test="error">{{ error }}</SfAlert>
    <SfAlert v-if="decided !== null" tone="success" data-test="decided">
      {{ decided.message }}
    </SfAlert>

    <SfSkeleton v-if="loading && empty" class="h-48" />

    <p v-else-if="empty" class="text-text-secondary" data-test="empty">
      {{ t('office.requests.empty') }}
    </p>

    <SfCard
      v-for="request in cancellations"
      :key="request.id"
      as="article"
      :data-test="`cancellation-${request.id}`"
    >
      <h2 class="text-lg font-medium">
        {{ t('office.requests.cancellationHeading', { reference: request.booking.reference }) }}
      </h2>
      <p class="text-text-secondary">
        {{ request.booking.customerName }} · {{ dateTime(request.booking.startsAt) }} ·
        {{ request.booking.serviceName }}
      </p>
      <p v-if="request.reason !== null" class="mt-1 text-sm">“{{ request.reason }}”</p>

      <dl class="mt-3 grid grid-cols-[auto_1fr] gap-x-4 text-sm">
        <dt class="text-text-secondary">{{ t('office.requests.paidLabel') }}</dt>
        <dd class="tabular-nums" data-test="paid">{{ money(request.booking.paid) }}</dd>
        <dt class="text-text-secondary">{{ t('office.requests.suggestedLabel') }}</dt>
        <dd class="tabular-nums" data-test="suggested">
          {{ money(request.suggestedRetainedAmountCents) }}
        </dd>
      </dl>

      <div class="mt-3 grid gap-3 sm:grid-cols-2">
        <SfInput
          v-if="session.can('refund.issue')"
          :model-value="retained[request.id] ?? ''"
          :label="t('office.requests.retainedLabel')"
          inputmode="decimal"
          :placeholder="String(request.suggestedRetainedAmountCents / 100)"
          data-test="retained"
          @update:model-value="(value) => (retained[request.id] = value)"
        />

        <SfInput
          :model-value="notes[request.id] ?? ''"
          :label="t('office.requests.noteLabel')"
          data-test="note"
          @update:model-value="(value) => (notes[request.id] = value)"
        />
      </div>

      <p
        v-if="session.can('refund.issue')"
        class="mt-2 text-sm"
        :class="retainedValid(request) ? '' : 'text-danger'"
        data-test="refund-preview"
      >
        <template v-if="retainedValid(request)">
          {{
            t('office.requests.refundGoesBack', {
              amount: money(refundCents(request)),
              name: request.booking.customerName,
            })
          }}
        </template>
        <template v-else>
          {{ t('office.requests.refundExceeds', { name: request.booking.customerName }) }}
        </template>
      </p>

      <div class="mt-3 flex flex-wrap gap-2">
        <SfButton
          :disabled="!retainedValid(request)"
          :loading="busy === request.id"
          :loading-label="t('office.requests.deciding')"
          data-test="approve"
          @click="decideCancellation(request, 'APPROVED')"
        >
          {{ t('office.requests.approveCancellation') }}
        </SfButton>
        <SfButton
          variant="secondary"
          :loading="busy === request.id"
          :loading-label="t('office.requests.deciding')"
          data-test="reject"
          @click="decideCancellation(request, 'REJECTED')"
        >
          {{ t('office.requests.rejectCancellation') }}
        </SfButton>
      </div>
    </SfCard>

    <SfCard
      v-for="request in reschedules"
      :key="request.id"
      as="article"
      :data-test="`reschedule-${request.id}`"
    >
      <h2 class="text-lg font-medium">
        {{ t('office.requests.rescheduleHeading', { reference: request.booking.reference }) }}
      </h2>
      <p class="text-text-secondary">
        {{ request.booking.customerName }} · {{ request.booking.serviceName }}
      </p>

      <dl class="mt-3 grid grid-cols-[auto_1fr] gap-x-4 text-sm">
        <dt class="text-text-secondary">{{ t('office.requests.fromLabel') }}</dt>
        <dd class="tabular-nums">{{ dateTime(request.booking.startsAt) }}</dd>
        <dt class="text-text-secondary">{{ t('office.requests.toLabel') }}</dt>
        <dd class="tabular-nums" data-test="requested-start">
          {{ dateTime(request.requestedStartsAt) }}
        </dd>
      </dl>

      <p v-if="request.reason !== null" class="mt-1 text-sm">“{{ request.reason }}”</p>

      <SfInput
        :model-value="notes[request.id] ?? ''"
        :label="t('office.requests.noteLabel')"
        class="mt-3"
        data-test="note"
        @update:model-value="(value) => (notes[request.id] = value)"
      />

      <div class="mt-3 flex flex-wrap gap-2">
        <SfButton
          :loading="busy === request.id"
          :loading-label="t('office.requests.deciding')"
          data-test="approve"
          @click="decideReschedule(request, 'APPROVED')"
        >
          {{ t('office.requests.approveReschedule') }}
        </SfButton>
        <SfButton
          variant="secondary"
          :loading="busy === request.id"
          :loading-label="t('office.requests.deciding')"
          data-test="reject"
          @click="decideReschedule(request, 'REJECTED')"
        >
          {{ t('office.requests.rejectReschedule') }}
        </SfButton>
      </div>
    </SfCard>
  </section>
</template>
