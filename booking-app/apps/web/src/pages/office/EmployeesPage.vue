<script setup lang="ts">
import {
  SfAlert,
  SfButton,
  SfCard,
  SfInput,
  SfModal,
  SfSkeleton,
} from '@shape-and-flow/booking-ui';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';

import { api } from '../../api/client.js';
import { useFocusStep } from '../../composables/useFocusStep.js';
import { today } from '../../office/format.js';
import { registerOfficeMessages } from '../../office/i18n/index.js';
import { officeMessage } from '../../office/messages.js';
import { blockingBookingCount, useCrudResource } from '../../office/useCrudResource.js';

import WorkingHoursEditor from './WorkingHoursEditor.vue';

import type {
  ConflictingBooking,
  OfficeEmployee,
  ReplaceWorkingHoursRequest,
} from '@shape-and-flow/booking-contracts';

/**
 * The team, and each person's week.
 *
 * The working-hours editor opens per person rather than as its own screen, because the
 * rota is a property of the person and an editor reached from a menu makes "whose week is
 * this?" a question the operator has to answer twice.
 *
 * An archive refusal is quantitative — three appointments are in the way — and the count
 * comes back in the error's `details`, so the message says how many rather than only that
 * it did not work.
 */
registerOfficeMessages();

const { t } = useI18n();

useFocusStep(() => t('office.employees.title'));

const includeArchived = ref(false);

const employees = useCrudResource<OfficeEmployee>(() =>
  api.office.employees.list(includeArchived.value),
);

const editing = ref<OfficeEmployee | null>(null);
const creating = ref(false);
const archiving = ref<OfficeEmployee | null>(null);

const form = ref({ firstName: '', lastName: '', displayName: '', email: '', phone: '' });

/** Whose archive was refused, so the count in the message has something to link to. */
const blockedEmployeeId = ref<string | null>(null);

/** How many appointments are in the way of an archive, so the message can pluralize once. */
const blockedCount = computed(() => blockingBookingCount(employees.errorDetails.value));

/** Whose week is open, and what the last save reported. */
const hours = ref<{
  employee: OfficeEmployee;
  segments: ReplaceWorkingHoursRequest['segments'];
} | null>(null);
const conflicts = ref<ConflictingBooking[]>([]);

function startCreate(): void {
  form.value = { firstName: '', lastName: '', displayName: '', email: '', phone: '' };
  creating.value = true;
  employees.clearError();
}

function startEdit(employee: OfficeEmployee): void {
  form.value = {
    firstName: employee.firstName,
    lastName: employee.lastName,
    displayName: employee.displayName,
    email: employee.email ?? '',
    phone: employee.phone ?? '',
  };
  editing.value = employee;
  employees.clearError();
}

function body() {
  return {
    firstName: form.value.firstName.trim(),
    lastName: form.value.lastName.trim(),
    ...(form.value.displayName.trim() === '' ? {} : { displayName: form.value.displayName.trim() }),
    email: form.value.email.trim() === '' ? null : form.value.email.trim(),
    phone: form.value.phone.trim() === '' ? null : form.value.phone.trim(),
  };
}

async function submitCreate(): Promise<void> {
  if (await employees.save(() => api.office.employees.create(body()))) creating.value = false;
}

async function submitEdit(): Promise<void> {
  const employee = editing.value;
  if (employee === null) return;

  if (await employees.save(() => api.office.employees.update(employee.id, body()))) {
    editing.value = null;
  }
}

async function confirmArchive(): Promise<void> {
  const employee = archiving.value;
  if (employee === null) return;

  if (await employees.save(() => api.office.employees.archive(employee.id))) {
    archiving.value = null;
    blockedEmployeeId.value = null;
  } else {
    blockedEmployeeId.value = employee.id;
  }
}

async function openHours(employee: OfficeEmployee): Promise<void> {
  conflicts.value = [];
  employees.clearError();

  // The calendar carries the stored week, which is the only endpoint that returns it —
  // a one-day range is enough, because working hours are a rule rather than a day. Today
  // rather than a fixed date: a hardcoded day says nothing about why it was chosen and
  // will eventually fall outside whatever range the server accepts.
  try {
    const calendar = await api.office.calendar({
      from: today(),
      to: today(),
      employeeId: employee.id,
    });

    hours.value = {
      employee,
      segments: calendar.workingHours
        .filter((segment) => segment.employeeId === employee.id)
        .map((segment) => ({
          weekday: segment.weekday,
          startMinute: segment.startMinute,
          endMinute: segment.endMinute,
          breaks: segment.breaks.map((rest) => ({
            startMinute: rest.startMinute,
            endMinute: rest.endMinute,
            ...(rest.label === null ? {} : { label: rest.label }),
          })),
        })),
    };
  } catch (caught) {
    // The editor stays shut, rather than opening on an empty week. An empty editor is not
    // "no hours yet", it is a rota nobody stored — and "Save week" pressed from there
    // replaces the real week with nothing.
    hours.value = null;
    employees.error.value = officeMessage(caught);
  }
}

async function saveHours(next: ReplaceWorkingHoursRequest): Promise<void> {
  const open = hours.value;
  if (open === null) return;

  const response = await employees.saveWith(() =>
    api.office.employees.replaceWorkingHours(open.employee.id, next),
  );

  if (response !== null) {
    // Reported, not enforced: the week is saved and these appointments now sit outside
    // it, which is a decision for a person rather than something to undo automatically.
    conflicts.value = response.conflictingBookings;
    hours.value = { employee: open.employee, segments: next.segments };
  }
}

async function toggleArchived(): Promise<void> {
  includeArchived.value = !includeArchived.value;
  await employees.reload();
}
</script>

<template>
  <section class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h1 ref="heading" tabindex="-1" class="text-xl font-semibold tracking-tight outline-none">
        {{ t('office.employees.title') }}
      </h1>

      <div class="flex gap-2">
        <SfButton variant="ghost" data-test="toggle-archived" @click="toggleArchived">
          {{
            includeArchived
              ? t('office.employees.hideArchived')
              : t('office.employees.showArchived')
          }}
        </SfButton>
        <SfButton data-test="add-employee" @click="startCreate">
          {{ t('office.employees.addButton') }}
        </SfButton>
      </div>
    </div>

    <SfAlert v-if="employees.error.value !== null" tone="danger" data-test="error">
      {{ employees.error.value }}
      <template v-if="blockedCount !== null">
        {{ t('office.employees.blockedAppointments', { count: blockedCount }, blockedCount) }}
        <!--
          The archive dialog stays open on a refusal, so the person being archived is still
          known and the link can point at their appointments. Closing it first would leave
          the count with nothing to click.
        -->
        <RouterLink
          v-if="blockedEmployeeId !== null"
          :to="{ name: 'office-bookings', query: { employeeId: blockedEmployeeId } }"
          class="underline"
        >
          {{ t('office.employees.showThemLink') }}
        </RouterLink>
      </template>
    </SfAlert>

    <SfSkeleton v-if="employees.loading.value && employees.items.value.length === 0" class="h-48" />

    <ul v-else class="space-y-2">
      <li
        v-for="employee in employees.items.value"
        :key="employee.id"
        class="flex flex-wrap items-center gap-3 rounded-sf border border-border bg-surface p-3"
        :data-test="`employee-${employee.id}`"
      >
        <span class="font-medium">{{ employee.displayName }}</span>
        <span class="text-sm text-text-secondary">
          {{ employee.email ?? t('office.employees.noEmail') }}
        </span>
        <span v-if="employee.archivedAt !== null" class="text-sm text-text-secondary">
          {{ t('office.employees.archivedTag') }}
        </span>

        <span class="ml-auto flex flex-wrap gap-2">
          <SfButton
            variant="ghost"
            :data-test="`hours-${employee.id}`"
            @click="openHours(employee)"
          >
            {{ t('office.employees.workingHoursButton') }}
          </SfButton>
          <SfButton variant="ghost" :data-test="`edit-${employee.id}`" @click="startEdit(employee)">
            {{ t('office.employees.editButton') }}
          </SfButton>
          <SfButton
            v-if="employee.archivedAt === null"
            variant="ghost"
            :data-test="`archive-${employee.id}`"
            @click="archiving = employee"
          >
            {{ t('office.employees.archiveButton') }}
          </SfButton>
        </span>
      </li>
    </ul>

    <SfCard v-if="hours !== null" as="section" aria-labelledby="hours-heading">
      <div class="flex items-baseline justify-between">
        <h2 id="hours-heading" class="text-lg font-medium">
          {{ t('office.employees.weekHeading', { name: hours.employee.displayName }) }}
        </h2>
        <SfButton variant="ghost" data-test="close-hours" @click="hours = null">
          {{ t('office.employees.close') }}
        </SfButton>
      </div>

      <WorkingHoursEditor
        class="mt-3"
        :segments="hours.segments"
        :conflicts="conflicts"
        :saving="employees.saving.value"
        @save="saveHours"
      />
    </SfCard>

    <SfModal
      :open="creating || editing !== null"
      :title="creating ? t('office.employees.addModalTitle') : t('office.employees.editModalTitle')"
      :confirm-label="t('office.employees.save')"
      :busy="employees.saving.value"
      @close="
        creating = false;
        editing = null;
      "
      @confirm="creating ? submitCreate() : submitEdit()"
    >
      <div class="space-y-3">
        <SfInput
          v-model="form.firstName"
          :label="t('office.employees.firstNameLabel')"
          required
          data-test="first-name"
        />
        <SfInput
          v-model="form.lastName"
          :label="t('office.employees.lastNameLabel')"
          required
          data-test="last-name"
        />
        <SfInput
          v-model="form.displayName"
          :label="t('office.employees.displayNameLabel')"
          :description="t('office.employees.displayNameHint')"
          data-test="display-name"
        />
        <SfInput
          v-model="form.email"
          type="email"
          :label="t('office.employees.emailLabel')"
          data-test="email"
        />
        <SfInput
          v-model="form.phone"
          type="tel"
          :label="t('office.employees.phoneLabel')"
          data-test="phone"
        />
      </div>
    </SfModal>

    <SfModal
      :open="archiving !== null"
      :title="t('office.employees.archiveModalTitle')"
      :confirm-label="t('office.employees.archiveConfirmLabel')"
      confirm-variant="danger"
      :busy="employees.saving.value"
      @close="archiving = null"
      @confirm="confirmArchive"
    >
      <p>
        {{ t('office.employees.archiveBody', { name: archiving?.displayName ?? '' }) }}
      </p>
    </SfModal>
  </section>
</template>
