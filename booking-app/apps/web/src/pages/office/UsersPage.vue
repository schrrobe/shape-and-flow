<script setup lang="ts">
import { officeUserRoleSchema } from '@shape-and-flow/booking-contracts';
import {
  SfAlert,
  SfButton,
  SfInput,
  SfModal,
  SfSelect,
  SfSkeleton,
} from '@shape-and-flow/booking-ui';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';

import { api } from '../../api/client.js';
import { useFocusStep } from '../../composables/useFocusStep.js';
import { dateTime } from '../../office/format.js';
import { registerOfficeMessages } from '../../office/i18n/index.js';
import { useCrudResource } from '../../office/useCrudResource.js';
import { useSession } from '../../stores/session.js';

registerOfficeMessages();

import type { OfficeUserListItem, OfficeUserRole } from '@shape-and-flow/booking-contracts';

/**
 * Who may sign in.
 *
 * **No password field.** Creating an account sends a reset link, so the person chooses
 * their own — an owner who types a colleague's first password knows it, and it travels
 * through a form and a request body for no benefit. The screen says what will happen
 * rather than leaving the absence of the field to be interpreted.
 *
 * The two self-protection rules are visible rather than discovered: your own row has no
 * archive button and no role picker, because the API refuses both and a control that
 * always 409s is a control that should not be there.
 */
const session = useSession();
const { t } = useI18n();

useFocusStep('Users');

const includeArchived = ref(false);

const users = useCrudResource<OfficeUserListItem>(() =>
  api.office.users.list(includeArchived.value),
);

const creating = ref(false);
const editing = ref<OfficeUserListItem | null>(null);
const archiving = ref<OfficeUserListItem | null>(null);
const notice = ref<string | null>(null);

/** The role name a person sees, rather than the raw enum value stored on the record. */
function roleLabel(role: OfficeUserRole): string {
  return t(`office.users.role.${role.toLowerCase()}`);
}

const ROLE_OPTIONS = computed(() =>
  officeUserRoleSchema.options.map((role) => ({
    value: role,
    label: roleLabel(role),
  })),
);

const REFUND_OPTIONS = computed(() => [
  { value: 'true', label: t('office.users.mayIssueRefunds') },
  { value: 'false', label: t('office.users.mayNotIssueRefunds') },
]);

const form = ref<{
  email: string;
  firstName: string;
  lastName: string;
  role: OfficeUserRole;
  canIssueRefunds: string;
}>({
  email: '',
  firstName: '',
  lastName: '',
  role: 'ADMIN',
  canIssueRefunds: 'false',
});

const isSelf = computed(() => (user: OfficeUserListItem) => user.id === session.user?.id);

function startCreate(): void {
  form.value = {
    email: '',
    firstName: '',
    lastName: '',
    role: 'ADMIN',
    canIssueRefunds: 'false',
  };
  creating.value = true;
  users.clearError();
  notice.value = null;
}

function startEdit(user: OfficeUserListItem): void {
  form.value = {
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
    canIssueRefunds: String(user.canIssueRefunds),
  };
  editing.value = user;
  users.clearError();
}

async function submitCreate(): Promise<void> {
  const done = await users.save(() =>
    api.office.users.create({
      email: form.value.email.trim(),
      firstName: form.value.firstName.trim(),
      lastName: form.value.lastName.trim(),
      role: form.value.role,
      canIssueRefunds: form.value.canIssueRefunds === 'true',
    }),
  );

  if (done) {
    creating.value = false;
    notice.value = t('office.users.invitationSent', { email: form.value.email.trim() });
  }
}

async function submitEdit(): Promise<void> {
  const user = editing.value;
  if (user === null) return;

  const done = await users.save(async () => {
    const result = await api.office.users.update(user.id, {
      firstName: form.value.firstName.trim(),
      lastName: form.value.lastName.trim(),
      ...(isSelf.value(user) ? {} : { role: form.value.role }),
      ...(isSelf.value(user) ? {} : { canIssueRefunds: form.value.canIssueRefunds === 'true' }),
    });

    if (result.revokedSessions > 0) {
      // Worth saying out loud: the person is signed out right now, and somebody will ask
      // why in about a minute.
      notice.value = t('office.users.signedOutNotice', { name: form.value.firstName });
    }
  });

  if (done) editing.value = null;
}

async function confirmArchive(): Promise<void> {
  const user = archiving.value;
  if (user === null) return;

  if (await users.save(() => api.office.users.archive(user.id))) {
    archiving.value = null;
    notice.value = t('office.users.archivedNotice');
  }
}
</script>

<template>
  <section class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h1 ref="heading" tabindex="-1" class="text-xl font-semibold tracking-tight outline-none">
        {{ t('office.users.heading') }}
      </h1>

      <div class="flex gap-2">
        <SfButton
          variant="ghost"
          data-test="toggle-archived"
          @click="
            includeArchived = !includeArchived;
            users.reload();
          "
        >
          {{ includeArchived ? t('office.users.hideArchived') : t('office.users.showArchived') }}
        </SfButton>
        <SfButton data-test="add-user" @click="startCreate">{{
          t('office.users.addUser')
        }}</SfButton>
      </div>
    </div>

    <SfAlert v-if="users.error.value !== null" tone="danger" data-test="error">
      {{ users.error.value }}
    </SfAlert>
    <SfAlert v-if="notice !== null" tone="success" data-test="notice">{{ notice }}</SfAlert>

    <SfSkeleton v-if="users.loading.value && users.items.value.length === 0" class="h-48" />

    <ul v-else class="space-y-2">
      <li
        v-for="user in users.items.value"
        :key="user.id"
        class="flex flex-wrap items-center gap-3 rounded-sf border border-border bg-surface p-3"
        :data-test="`user-${user.id}`"
      >
        <span class="font-medium">{{ user.firstName }} {{ user.lastName }}</span>
        <span class="text-sm break-all text-text-secondary">{{ user.email }}</span>
        <span class="text-sm">{{ roleLabel(user.role) }}</span>
        <span v-if="user.canIssueRefunds" class="text-sm text-text-secondary">
          {{ t('office.users.refundsBadge') }}
        </span>
        <span v-if="isSelf(user)" class="text-sm text-text-secondary">
          {{ t('office.users.youBadge') }}
        </span>
        <span v-if="user.archivedAt !== null" class="text-sm text-text-secondary">
          {{ t('office.users.archivedBadge') }}
        </span>
        <span v-if="user.lockedUntil !== null" class="text-sm text-warning">
          {{ t('office.users.lockedUntil', { date: dateTime(user.lockedUntil) }) }}
        </span>

        <span class="ml-auto flex gap-2">
          <SfButton variant="ghost" :data-test="`edit-${user.id}`" @click="startEdit(user)">
            {{ t('office.users.edit') }}
          </SfButton>
          <!--
            Absent for your own row rather than disabled: the API refuses it, and a
            control that always 409s is one nobody should be offered.
          -->
          <SfButton
            v-if="!isSelf(user) && user.archivedAt === null"
            variant="ghost"
            :data-test="`archive-${user.id}`"
            @click="archiving = user"
          >
            {{ t('office.users.archive') }}
          </SfButton>
        </span>
      </li>
    </ul>

    <SfModal
      :open="creating"
      :title="t('office.users.addUser')"
      :confirm-label="t('office.users.sendInvitation')"
      :busy="users.saving.value"
      @close="creating = false"
      @confirm="submitCreate"
    >
      <div class="space-y-3">
        <p class="text-sm text-text-secondary">
          {{ t('office.users.noPasswordNote') }}
        </p>

        <SfInput
          v-model="form.email"
          type="email"
          :label="t('office.users.emailLabel')"
          required
          data-test="user-email"
        />
        <SfInput
          v-model="form.firstName"
          :label="t('office.users.firstNameLabel')"
          required
          data-test="user-first"
        />
        <SfInput
          v-model="form.lastName"
          :label="t('office.users.lastNameLabel')"
          required
          data-test="user-last"
        />

        <SfSelect
          :model-value="form.role"
          :label="t('office.users.roleLabel')"
          :options="ROLE_OPTIONS"
          data-test="user-role"
          @update:model-value="(value) => (form.role = value as OfficeUserRole)"
        />

        <SfSelect
          :model-value="form.canIssueRefunds"
          :label="t('office.users.refundsLabel')"
          :options="REFUND_OPTIONS"
          :description="t('office.users.ownerAlwaysRefunds')"
          data-test="user-refunds"
          @update:model-value="(value) => (form.canIssueRefunds = value)"
        />
      </div>
    </SfModal>

    <SfModal
      :open="editing !== null"
      :title="t('office.users.editUserTitle')"
      :confirm-label="t('office.users.save')"
      :busy="users.saving.value"
      @close="editing = null"
      @confirm="submitEdit"
    >
      <div class="space-y-3">
        <SfInput
          v-model="form.firstName"
          :label="t('office.users.firstNameLabel')"
          data-test="user-first"
        />
        <SfInput
          v-model="form.lastName"
          :label="t('office.users.lastNameLabel')"
          data-test="user-last"
        />

        <template v-if="editing !== null && !isSelf(editing)">
          <SfSelect
            :model-value="form.role"
            :label="t('office.users.roleLabel')"
            :options="ROLE_OPTIONS"
            data-test="user-role"
            @update:model-value="(value) => (form.role = value as OfficeUserRole)"
          />

          <SfSelect
            :model-value="form.canIssueRefunds"
            :label="t('office.users.refundsLabel')"
            :options="REFUND_OPTIONS"
            data-test="user-refunds"
            @update:model-value="(value) => (form.canIssueRefunds = value)"
          />

          <p class="text-sm text-text-secondary">
            {{ t('office.users.roleChangeSignsOut') }}
          </p>
        </template>

        <p v-else class="text-sm text-text-secondary">
          {{ t('office.users.cannotChangeSelf') }}
        </p>
      </div>
    </SfModal>

    <SfModal
      :open="archiving !== null"
      :title="t('office.users.archiveTitle')"
      :confirm-label="t('office.users.archive')"
      confirm-variant="danger"
      :busy="users.saving.value"
      @close="archiving = null"
      @confirm="confirmArchive"
    >
      <p>
        {{
          t('office.users.archiveWarning', {
            name: `${archiving?.firstName ?? ''} ${archiving?.lastName ?? ''}`.trim(),
          })
        }}
      </p>
    </SfModal>
  </section>
</template>
