<script setup lang="ts">
import { replaceWorkingHoursSchema, weekdaySchema } from '@shape-and-flow/booking-contracts';
import { SfAlert, SfButton, SfInput, SfSelect } from '@shape-and-flow/booking-ui';
import { computed, ref, watch } from 'vue';

import { dateTime, minuteOfDay, parseMinuteOfDay } from '../../office/format.js';

import type {
  ConflictingBooking,
  ReplaceWorkingHoursRequest,
  Weekday,
} from '@shape-and-flow/booking-contracts';

/**
 * A week of shifts, edited in wall clock and submitted in minutes.
 *
 * **The rules are checked here by the same schema the API uses.** Not re-typed: the
 * component imports `replaceWorkingHoursSchema` from the contracts package and runs it,
 * so an overlap, a break outside its shift and an inverted range are all flagged by the
 * definition that will refuse them anyway. A second hand-written copy of "breaks may not
 * overlap" is a copy that drifts, and the drift shows up as a form that lets somebody
 * save something the server then rejects.
 *
 * `24:00` is legal and means the next midnight, which is how a rota is written. `00:00`
 * would read as the shift starting rather than ending.
 */
const props = defineProps<{
  segments: ReplaceWorkingHoursRequest['segments'];
  conflicts?: ConflictingBooking[];
  saving?: boolean;
}>();

const emit = defineEmits<{ save: [ReplaceWorkingHoursRequest] }>();

const WEEKDAYS = weekdaySchema.options;
const WEEKDAY_OPTIONS = WEEKDAYS.map((day) => ({
  value: day,
  label: day.charAt(0) + day.slice(1).toLowerCase(),
}));

/** The form's own shape: wall-clock strings, because that is what a person types. */
interface DraftBreak {
  start: string;
  end: string;
  label: string;
}

interface DraftSegment {
  weekday: Weekday;
  start: string;
  end: string;
  breaks: DraftBreak[];
}

const draft = ref<DraftSegment[]>([]);

/** Rebuilt from the prop, so a reload after a save shows what was actually stored. */
watch(
  () => props.segments,
  (segments) => {
    draft.value = segments.map((segment) => ({
      weekday: segment.weekday,
      start: minuteOfDay(segment.startMinute),
      end: minuteOfDay(segment.endMinute),
      breaks: segment.breaks.map((rest) => ({
        start: minuteOfDay(rest.startMinute),
        end: minuteOfDay(rest.endMinute),
        label: rest.label ?? '',
      })),
    }));
  },
  { immediate: true, deep: true },
);

/**
 * The draft as the request body, or `null` when a time is not a time yet.
 *
 * `null` rather than throwing: somebody halfway through typing `9` has not made a
 * mistake, and a form that shouts at every keystroke is one people learn to ignore.
 */
const body = computed<ReplaceWorkingHoursRequest | null>(() => {
  const segments: ReplaceWorkingHoursRequest['segments'] = [];

  for (const segment of draft.value) {
    const startMinute = parseMinuteOfDay(segment.start);
    const endMinute = parseMinuteOfDay(segment.end);
    if (startMinute === null || endMinute === null) return null;

    const breaks = [];
    for (const rest of segment.breaks) {
      const breakStart = parseMinuteOfDay(rest.start);
      const breakEnd = parseMinuteOfDay(rest.end);
      if (breakStart === null || breakEnd === null) return null;

      breaks.push({
        startMinute: breakStart,
        endMinute: breakEnd,
        ...(rest.label.trim() === '' ? {} : { label: rest.label.trim() }),
      });
    }

    segments.push({ weekday: segment.weekday, startMinute, endMinute, breaks });
  }

  return { segments };
});

/**
 * What the contract says is wrong, in the contract's own words.
 *
 * The messages come from the Zod refinements — "segments on the same weekday must not
 * overlap", "a break must lie inside the segment that contains it" — so the form and the
 * API cannot disagree about what is wrong or about what to call it.
 */
const problems = computed<string[]>(() => {
  if (body.value === null) return ['Every time must be written as HH:MM, for example 09:00.'];

  const result = replaceWorkingHoursSchema.safeParse(body.value);
  if (result.success) return [];

  // De-duplicated: one overlap produces the same message once per affected segment, and
  // an operator does not need to be told three times.
  return [...new Set(result.error.issues.map((issue) => issue.message))];
});

const valid = computed(() => problems.value.length === 0);

function addSegment(): void {
  draft.value.push({ weekday: 'MONDAY', start: '09:00', end: '17:00', breaks: [] });
}

function removeSegment(index: number): void {
  draft.value.splice(index, 1);
}

function addBreak(index: number): void {
  draft.value[index]?.breaks.push({ start: '12:00', end: '12:30', label: '' });
}

function removeBreak(segmentIndex: number, breakIndex: number): void {
  draft.value[segmentIndex]?.breaks.splice(breakIndex, 1);
}

function submit(): void {
  const value = body.value;
  if (value === null || !valid.value) return;

  emit('save', value);
}
</script>

<template>
  <form class="space-y-4" @submit.prevent="submit">
    <fieldset
      v-for="(segment, index) in draft"
      :key="index"
      class="rounded-sf border border-border p-3"
    >
      <legend class="px-1 text-sm font-medium">Shift {{ index + 1 }}</legend>

      <div class="grid gap-3 sm:grid-cols-4">
        <SfSelect
          :model-value="segment.weekday"
          label="Day"
          :options="WEEKDAY_OPTIONS"
          :data-test="`weekday-${index}`"
          @update:model-value="(value) => (segment.weekday = value as Weekday)"
        />

        <SfInput
          v-model="segment.start"
          label="From"
          placeholder="09:00"
          :data-test="`start-${index}`"
        />

        <SfInput
          v-model="segment.end"
          label="To (24:00 means midnight)"
          placeholder="18:00"
          :data-test="`end-${index}`"
        />

        <div class="flex items-end">
          <SfButton
            variant="ghost"
            :data-test="`remove-segment-${index}`"
            @click="removeSegment(index)"
          >
            Remove shift
          </SfButton>
        </div>
      </div>

      <div
        v-for="(rest, breakIndex) in segment.breaks"
        :key="breakIndex"
        class="mt-3 grid gap-3 border-l-2 border-border pl-3 sm:grid-cols-4"
      >
        <SfInput
          v-model="rest.start"
          label="Break from"
          :data-test="`break-start-${index}-${breakIndex}`"
        />
        <SfInput
          v-model="rest.end"
          label="Break to"
          :data-test="`break-end-${index}-${breakIndex}`"
        />
        <SfInput
          v-model="rest.label"
          label="Called"
          :data-test="`break-label-${index}-${breakIndex}`"
        />
        <div class="flex items-end">
          <SfButton
            variant="ghost"
            :data-test="`remove-break-${index}-${breakIndex}`"
            @click="removeBreak(index, breakIndex)"
          >
            Remove break
          </SfButton>
        </div>
      </div>

      <SfButton
        variant="ghost"
        class="mt-2"
        :data-test="`add-break-${index}`"
        @click="addBreak(index)"
      >
        Add a break
      </SfButton>
    </fieldset>

    <SfButton variant="secondary" data-test="add-segment" @click="addSegment">Add a shift</SfButton>

    <SfAlert v-if="problems.length > 0" tone="warning" data-test="problems">
      <ul class="list-inside list-disc">
        <li v-for="problem in problems" :key="problem">{{ problem }}</li>
      </ul>
    </SfAlert>

    <!--
      What the server found after the save went through. Reported rather than enforced:
      the week is saved and these appointments are now outside it, which is a decision for
      a person.
    -->
    <SfAlert v-if="(conflicts ?? []).length > 0" tone="warning" data-test="conflicts">
      <p class="font-medium">These appointments are now outside the saved hours:</p>
      <ul class="mt-1 list-inside list-disc">
        <li v-for="conflict in conflicts" :key="conflict.id">
          {{ conflict.reference }} — {{ dateTime(conflict.startsAt) }} —
          {{ conflict.customerName }} — {{ conflict.serviceName }}
        </li>
      </ul>
    </SfAlert>

    <!--
      A click handler as well as the form's submit: the button saves when it is pressed,
      and the form saves when Enter is pressed in any field. Relying on the implicit
      submission alone would make the keyboard path the only one that works in some
      environments, and the mouse path the only one that works in others.
    -->
    <SfButton
      :disabled="!valid"
      :loading="saving === true"
      loading-label="Saving"
      data-test="save"
      @click="submit"
    >
      Save the week
    </SfButton>
  </form>
</template>
