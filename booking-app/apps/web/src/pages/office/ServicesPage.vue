<script setup lang="ts">
import { SERVICE_BOUNDS, createServiceSchema } from '@shape-and-flow/booking-contracts';
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
import { euros, money } from '../../office/format.js';
import { registerOfficeMessages } from '../../office/i18n/index.js';
import {
  blockingBookingCount,
  blockingServiceCount,
  useCrudResource,
} from '../../office/useCrudResource.js';

import type { OfficeService, OfficeServiceCategory } from '@shape-and-flow/booking-contracts';

/**
 * What the business sells, and the headings it sells it under.
 *
 * **The bounds come from the contract, not from re-typed numbers.** `SERVICE_BOUNDS` is
 * the same table the API's Zod schema is built from and the same one the database `CHECK`
 * is compared against, so a duration this form accepts is a duration the server accepts.
 * Typing `5` and `480` here would be a third copy, and the third copy is the one that
 * drifts.
 *
 * Neither a service nor a category can be deleted, only archived — a booking's foreign
 * key points at these rows. The screen says so rather than offering a delete that 409s.
 */
registerOfficeMessages();

const { t } = useI18n();

useFocusStep('Treatments');

const includeArchived = ref(false);

const services = useCrudResource<OfficeService>(() =>
  api.office.catalog.services({ includeArchived: includeArchived.value }),
);

const categories = useCrudResource<OfficeServiceCategory>(() =>
  api.office.catalog.categories(includeArchived.value),
);

const editing = ref<OfficeService | null>(null);
const creating = ref(false);
const archiving = ref<OfficeService | null>(null);
const archivingCategory = ref<OfficeServiceCategory | null>(null);
const creatingCategory = ref(false);
const categoryName = ref('');

const form = ref({
  name: '',
  description: '',
  serviceCategoryId: '',
  durationMinutes: '30',
  prepBufferMinutes: '0',
  cleanupBufferMinutes: '0',
  priceEuros: '45.00',
});

const categoryOptions = computed(() => [
  { value: '', label: t('office.services.noCategoryOption') },
  ...categories.items.value
    .filter((category) => category.archivedAt === null)
    .map((category) => ({ value: category.id, label: category.name })),
]);

function toCents(value: string): number {
  const normalised = value.trim().replace(',', '.');
  return Math.round(Number(normalised) * 100);
}

/** The body, run through the contract so the form refuses what the API would. */
const body = computed(() => ({
  name: form.value.name.trim(),
  ...(form.value.description.trim() === '' ? {} : { description: form.value.description.trim() }),
  serviceCategoryId: form.value.serviceCategoryId === '' ? null : form.value.serviceCategoryId,
  durationMinutes: Number(form.value.durationMinutes),
  prepBufferMinutes: Number(form.value.prepBufferMinutes),
  cleanupBufferMinutes: Number(form.value.cleanupBufferMinutes),
  priceCents: toCents(form.value.priceEuros),
}));

const problems = computed(() => {
  const result = createServiceSchema.safeParse(body.value);
  if (result.success) return [];

  return [
    ...new Set(result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)),
  ];
});

function startCreate(): void {
  form.value = {
    name: '',
    description: '',
    serviceCategoryId: '',
    durationMinutes: '30',
    prepBufferMinutes: '0',
    cleanupBufferMinutes: '0',
    priceEuros: '45.00',
  };
  creating.value = true;
  services.clearError();
}

function startEdit(service: OfficeService): void {
  form.value = {
    name: service.name,
    description: service.description ?? '',
    serviceCategoryId: service.serviceCategoryId ?? '',
    durationMinutes: String(service.durationMinutes),
    prepBufferMinutes: String(service.prepBufferMinutes),
    cleanupBufferMinutes: String(service.cleanupBufferMinutes),
    priceEuros: euros(service.price),
  };
  editing.value = service;
  services.clearError();
}

async function submitCreate(): Promise<void> {
  if (problems.value.length > 0) return;
  if (await services.save(() => api.office.catalog.createService(body.value)))
    creating.value = false;
}

async function submitEdit(): Promise<void> {
  const service = editing.value;
  if (service === null || problems.value.length > 0) return;

  if (await services.save(() => api.office.catalog.updateService(service.id, body.value))) {
    editing.value = null;
  }
}

async function confirmArchive(): Promise<void> {
  const service = archiving.value;
  if (service === null) return;

  if (await services.save(() => api.office.catalog.archiveService(service.id))) {
    archiving.value = null;
  }
}

async function submitCategory(): Promise<void> {
  const name = categoryName.value.trim();
  if (name === '') return;

  if (await categories.save(() => api.office.catalog.createCategory({ name }))) {
    creatingCategory.value = false;
    categoryName.value = '';
  }
}

async function confirmArchiveCategory(): Promise<void> {
  const category = archivingCategory.value;
  if (category === null) return;

  if (await categories.save(() => api.office.catalog.archiveCategory(category.id))) {
    archivingCategory.value = null;
    await services.reload();
  }
}
</script>

<template>
  <section class="space-y-6">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h1 ref="heading" tabindex="-1" class="text-xl font-semibold tracking-tight outline-none">
        {{ t('office.services.title') }}
      </h1>

      <div class="flex gap-2">
        <SfButton
          variant="ghost"
          data-test="toggle-archived"
          @click="
            includeArchived = !includeArchived;
            services.reload();
            categories.reload();
          "
        >
          {{
            includeArchived ? t('office.services.hideArchived') : t('office.services.showArchived')
          }}
        </SfButton>
        <SfButton data-test="add-service" @click="startCreate">
          {{ t('office.services.addTreatment') }}
        </SfButton>
      </div>
    </div>

    <SfAlert v-if="services.error.value !== null" tone="danger" data-test="error">
      {{ services.error.value }}
      <template v-if="blockingBookingCount(services.errorDetails.value) !== null">
        {{
          t(
            'office.services.blockingAppointments',
            { count: blockingBookingCount(services.errorDetails.value) },
            blockingBookingCount(services.errorDetails.value) ?? 0,
          )
        }}
      </template>
    </SfAlert>

    <SfSkeleton v-if="services.loading.value && services.items.value.length === 0" class="h-48" />

    <ul v-else class="space-y-2">
      <li
        v-for="service in services.items.value"
        :key="service.id"
        class="flex flex-wrap items-center gap-3 rounded-sf border border-border bg-surface p-3"
        :data-test="`service-${service.id}`"
      >
        <span class="font-medium">{{ service.name }}</span>
        <span class="text-sm text-text-secondary">{{ service.durationMinutes }} min</span>
        <span class="text-sm tabular-nums">{{ money(service.price) }}</span>
        <span v-if="service.archivedAt !== null" class="text-sm text-text-secondary">
          {{ t('office.services.archivedBadge') }}
        </span>

        <span class="ml-auto flex gap-2">
          <SfButton variant="ghost" :data-test="`edit-${service.id}`" @click="startEdit(service)">
            {{ t('office.services.editAction') }}
          </SfButton>
          <SfButton
            v-if="service.archivedAt === null"
            variant="ghost"
            :data-test="`archive-${service.id}`"
            @click="archiving = service"
          >
            {{ t('office.services.archiveAction') }}
          </SfButton>
        </span>
      </li>
    </ul>

    <section class="space-y-2" aria-labelledby="categories-heading">
      <div class="flex items-baseline justify-between">
        <h2 id="categories-heading" class="text-lg font-medium">
          {{ t('office.services.categoriesHeading') }}
        </h2>
        <SfButton variant="ghost" data-test="add-category" @click="creatingCategory = true">
          {{ t('office.services.addCategory') }}
        </SfButton>
      </div>

      <SfAlert v-if="categories.error.value !== null" tone="danger" data-test="category-error">
        {{ categories.error.value }}
        <template v-if="blockingServiceCount(categories.errorDetails.value) !== null">
          {{
            t(
              'office.services.blockingTreatments',
              { count: blockingServiceCount(categories.errorDetails.value) },
              blockingServiceCount(categories.errorDetails.value) ?? 0,
            )
          }}
        </template>
      </SfAlert>

      <ul class="space-y-2">
        <li
          v-for="category in categories.items.value"
          :key="category.id"
          class="flex flex-wrap items-center gap-3 rounded-sf border border-border bg-surface p-3"
          :data-test="`category-${category.id}`"
        >
          <span class="font-medium">{{ category.name }}</span>
          <span class="text-sm text-text-secondary">
            {{
              t(
                'office.services.categoryServiceCount',
                { count: category.activeServiceCount },
                category.activeServiceCount,
              )
            }}
          </span>
          <SfButton
            v-if="category.archivedAt === null"
            variant="ghost"
            class="ml-auto"
            :data-test="`archive-category-${category.id}`"
            @click="archivingCategory = category"
          >
            {{ t('office.services.archiveAction') }}
          </SfButton>
        </li>
      </ul>
    </section>

    <SfModal
      :open="creating || editing !== null"
      :title="
        creating ? t('office.services.addTreatment') : t('office.services.editTreatmentTitle')
      "
      :confirm-label="t('office.services.saveAction')"
      :busy="services.saving.value"
      @close="
        creating = false;
        editing = null;
      "
      @confirm="creating ? submitCreate() : submitEdit()"
    >
      <div class="space-y-3">
        <SfInput
          v-model="form.name"
          :label="t('office.services.nameLabel')"
          required
          data-test="service-name"
        />
        <SfInput
          v-model="form.description"
          :label="t('office.services.descriptionLabel')"
          data-test="service-description"
        />

        <SfSelect
          :model-value="form.serviceCategoryId"
          :label="t('office.services.categoryLabel')"
          :options="categoryOptions"
          data-test="service-category"
          @update:model-value="(value) => (form.serviceCategoryId = value)"
        />

        <SfInput
          v-model="form.durationMinutes"
          type="number"
          :label="t('office.services.minutesLabel')"
          :min="SERVICE_BOUNDS.durationMinutes.min"
          :max="SERVICE_BOUNDS.durationMinutes.max"
          data-test="service-duration"
        />

        <SfInput
          v-model="form.prepBufferMinutes"
          type="number"
          :label="t('office.services.prepLabel')"
          :min="SERVICE_BOUNDS.prepBufferMinutes.min"
          :max="SERVICE_BOUNDS.prepBufferMinutes.max"
          :description="t('office.services.prepDescription')"
          data-test="service-prep"
        />

        <SfInput
          v-model="form.cleanupBufferMinutes"
          type="number"
          :label="t('office.services.cleanupLabel')"
          :min="SERVICE_BOUNDS.cleanupBufferMinutes.min"
          :max="SERVICE_BOUNDS.cleanupBufferMinutes.max"
          data-test="service-cleanup"
        />

        <SfInput
          v-model="form.priceEuros"
          :label="t('office.services.priceLabel')"
          inputmode="decimal"
          data-test="service-price"
        />

        <SfAlert v-if="problems.length > 0" tone="warning" data-test="service-problems">
          <ul class="list-inside list-disc">
            <li v-for="problem in problems" :key="problem">{{ problem }}</li>
          </ul>
        </SfAlert>
      </div>
    </SfModal>

    <SfModal
      :open="creatingCategory"
      :title="t('office.services.addCategory')"
      :confirm-label="t('office.services.saveAction')"
      :busy="categories.saving.value"
      @close="creatingCategory = false"
      @confirm="submitCategory"
    >
      <SfInput
        v-model="categoryName"
        :label="t('office.services.nameLabel')"
        required
        data-test="category-name"
      />
    </SfModal>

    <SfModal
      :open="archiving !== null"
      :title="t('office.services.archiveServiceTitle')"
      :confirm-label="t('office.services.archiveAction')"
      confirm-variant="danger"
      :busy="services.saving.value"
      @close="archiving = null"
      @confirm="confirmArchive"
    >
      <p>{{ t('office.services.archiveServiceBody') }}</p>
    </SfModal>

    <SfModal
      :open="archivingCategory !== null"
      :title="t('office.services.archiveCategoryTitle')"
      :confirm-label="t('office.services.archiveAction')"
      confirm-variant="danger"
      :busy="categories.saving.value"
      @close="archivingCategory = null"
      @confirm="confirmArchiveCategory"
    >
      <p>{{ t('office.services.archiveCategoryBody') }}</p>
    </SfModal>
  </section>
</template>
