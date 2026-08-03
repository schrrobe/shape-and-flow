import { z } from 'zod';

import { cancellationFeePolicySchema } from '../enums.js';
import { boundedInt, cuidSchema, localeSchema } from '../primitives.js';

/**
 * Organization identity and every configurable policy.
 *
 * **The bounds are data, not literals.** `SETTINGS_BOUNDS` is the one place a number
 * like "the booking horizon is at most a year" is written down; the Zod schema is built
 * from it, and `office-admin.int.spec.ts` reads
 * `organization_settings_ranges_check` back out of PostgreSQL and asserts the same
 * numbers appear there. The database `CHECK` is the backstop for anything that bypasses
 * the API, and a backstop that disagreed with the front would turn a 400 into a 500.
 */
export const SETTINGS_BOUNDS = {
  /**
   * The slot grid, in minutes. A set rather than a range: seven-minute slots are not a
   * stricter version of five-minute slots, they are a grid no appointment business
   * lays out and every clock face fights.
   */
  schedulingIntervalMinutes: [5, 10, 15, 20, 30, 60],
  bookingHorizonDays: { min: 1, max: 365 },
  minimumNoticeHours: { min: 0, max: 720 },
  reservationTtlMinutes: { min: 3, max: 30 },
  freeCancellationHours: { min: 0, max: 720 },
  cancellationFeePercent: { min: 0, max: 100 },
  dataRetentionDays: { min: 30, max: 3650 },
} as const;

/**
 * The settings fields, flat.
 *
 * Declared once as a shape so the response and the patch cannot drift: the patch is
 * this made partial, rather than a second list somebody has to remember to extend.
 */
const settingsShape = {
  schedulingIntervalMinutes: z
    .number()
    .int()
    .refine(
      (value) => (SETTINGS_BOUNDS.schedulingIntervalMinutes as readonly number[]).includes(value),
      `must be one of ${SETTINGS_BOUNDS.schedulingIntervalMinutes.join(', ')}`,
    ),
  bookingHorizonDays: boundedInt(SETTINGS_BOUNDS.bookingHorizonDays),
  minimumNoticeHours: boundedInt(SETTINGS_BOUNDS.minimumNoticeHours),
  reservationTtlMinutes: boundedInt(SETTINGS_BOUNDS.reservationTtlMinutes),
  freeCancellationHours: boundedInt(SETTINGS_BOUNDS.freeCancellationHours),
  cancellationFeePolicy: cancellationFeePolicySchema,
  cancellationFeeAmountCents: z.number().int().min(0).max(10_000_000),
  cancellationFeePercent: boundedInt(SETTINGS_BOUNDS.cancellationFeePercent),
  /**
   * How long before an appointment each reminder goes out, in minutes.
   *
   * Sorted and de-duplicated on write, because two identical offsets would produce two
   * identical reminders, and the reminder job's id is keyed by offset.
   */
  reminderOffsetsMinutes: z.array(z.number().int().min(5).max(43_200)).max(5),
  smsRemindersEnabled: z.boolean(),
  customerNoteEnabled: z.boolean(),
  dataRetentionDays: boundedInt(SETTINGS_BOUNDS.dataRetentionDays),
  officeNotificationEmail: z.email().max(320),
} as const;

/** Identity, as the office edits it. `slug` is absent: it is how the tenant resolves. */
export const officeOrganizationSchema = z.object({
  id: cuidSchema,
  name: z.string(),
  legalName: z.string(),
  contactEmail: z.string(),
  contactPhone: z.string(),
  whatsappNumber: z.string().nullable(),
  addressLine1: z.string(),
  addressLine2: z.string().nullable(),
  postalCode: z.string(),
  city: z.string(),
  country: z.string(),
  timezone: z.string(),
  currency: z.string().length(3),
  defaultLocale: localeSchema,
});

export const updateOrganizationSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  legalName: z.string().trim().min(1).max(200).optional(),
  contactEmail: z.email().max(320).optional(),
  contactPhone: z.string().trim().min(1).max(50).optional(),
  whatsappNumber: z.string().trim().max(50).nullish(),
  addressLine1: z.string().trim().min(1).max(200).optional(),
  addressLine2: z.string().trim().max(200).nullish(),
  postalCode: z.string().trim().min(1).max(20).optional(),
  city: z.string().trim().min(1).max(120).optional(),
  country: z.string().trim().length(2).optional(),
  defaultLocale: localeSchema.optional(),
});

export const officeSettingsResponseSchema = z.object({
  organization: officeOrganizationSchema,
  ...settingsShape,
});

export type OfficeSettingsResponse = z.infer<typeof officeSettingsResponseSchema>;

/**
 * The patch.
 *
 * Every settings field optional and flat, with identity nested under `organization` —
 * two rows in the database, and the nesting is what says so. `timezone` and `currency`
 * are absent on purpose: both are baked into every stored booking's snapshot, so
 * changing either is a migration rather than a setting.
 */
export const updateOfficeSettingsSchema = z
  .object({
    organization: updateOrganizationSchema.optional(),
    ...settingsShape,
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, {
    message: 'the patch must change at least one field',
    path: [],
  });

export type UpdateOfficeSettingsRequest = z.infer<typeof updateOfficeSettingsSchema>;
