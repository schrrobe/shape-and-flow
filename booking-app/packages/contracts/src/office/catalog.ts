import { z } from 'zod';

import { booleanQuery, cuidSchema, isoInstantSchema, moneySchema } from '../primitives.js';

/**
 * What the business sells, as the office edits it.
 *
 * The numeric bounds below are the same numbers the `services_*` database `CHECK`
 * constraints enforce, and `office-admin.int.spec.ts` reads the constraint definitions
 * back out of PostgreSQL and compares them against this table. Two independently
 * maintained copies of "a service lasts between five minutes and eight hours" would
 * drift, and the drift would show up as a 500 where a 400 was meant.
 */
export const SERVICE_BOUNDS = {
  durationMinutes: { min: 5, max: 480 },
  prepBufferMinutes: { min: 0, max: 120 },
  cleanupBufferMinutes: { min: 0, max: 120 },
} as const;

const bounded = (bounds: { min: number; max: number }) =>
  z.number().int().min(bounds.min).max(bounds.max);

/* ── categories ───────────────────────────────────────────────────────────────── */

export const officeServiceCategorySchema = z.object({
  id: cuidSchema,
  name: z.string(),
  description: z.string().nullable(),
  displayOrder: z.number().int(),
  archivedAt: isoInstantSchema.nullable(),
  /** Live services in this category, which is what makes archiving refusable. */
  activeServiceCount: z.number().int(),
});

export type OfficeServiceCategory = z.infer<typeof officeServiceCategorySchema>;

export const createServiceCategorySchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).nullish(),
  displayOrder: z.number().int().min(0).max(9999).optional(),
});

export type CreateServiceCategoryRequest = z.infer<typeof createServiceCategorySchema>;

export const updateServiceCategorySchema = createServiceCategorySchema.partial();
export type UpdateServiceCategoryRequest = z.infer<typeof updateServiceCategorySchema>;

export const serviceCategoryListQuerySchema = z.object({
  includeArchived: booleanQuery(false),
});

export type ServiceCategoryListQuery = z.infer<typeof serviceCategoryListQuerySchema>;

// `office` in the name because the public catalog exports a
// `serviceCategoryListResponseSchema` of its own, and the two are genuinely different
// shapes: this one carries archived rows and a service count, that one carries prices.
export const officeServiceCategoryListResponseSchema = z.object({
  items: z.array(officeServiceCategorySchema),
});

export type OfficeServiceCategoryListResponse = z.infer<
  typeof officeServiceCategoryListResponseSchema
>;

/* ── services ─────────────────────────────────────────────────────────────────── */

export const officeServiceSchema = z.object({
  id: cuidSchema,
  serviceCategoryId: cuidSchema.nullable(),
  name: z.string(),
  description: z.string().nullable(),
  durationMinutes: z.number().int(),
  /**
   * Buffers are the employee's time and not the customer's: they widen the block a
   * booking occupies while `startsAt`/`endsAt` stay what the customer was told.
   */
  prepBufferMinutes: z.number().int(),
  cleanupBufferMinutes: z.number().int(),
  price: moneySchema,
  isBookableOnline: z.boolean(),
  displayOrder: z.number().int(),
  archivedAt: isoInstantSchema.nullable(),
});

export type OfficeService = z.infer<typeof officeServiceSchema>;

export const createServiceSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(4000).nullish(),
  serviceCategoryId: cuidSchema.nullish(),
  durationMinutes: bounded(SERVICE_BOUNDS.durationMinutes),
  prepBufferMinutes: bounded(SERVICE_BOUNDS.prepBufferMinutes).optional(),
  cleanupBufferMinutes: bounded(SERVICE_BOUNDS.cleanupBufferMinutes).optional(),
  priceCents: z.number().int().min(0).max(10_000_000),
  isBookableOnline: z.boolean().optional(),
  displayOrder: z.number().int().min(0).max(9999).optional(),
});

export type CreateServiceRequest = z.infer<typeof createServiceSchema>;

export const updateServiceSchema = createServiceSchema.partial();
export type UpdateServiceRequest = z.infer<typeof updateServiceSchema>;

export const serviceListQuerySchema = z.object({
  includeArchived: booleanQuery(false),
  serviceCategoryId: cuidSchema.optional(),
});

export type ServiceListQuery = z.infer<typeof serviceListQuerySchema>;

export const officeServiceListResponseSchema = z.object({ items: z.array(officeServiceSchema) });
export type OfficeServiceListResponse = z.infer<typeof officeServiceListResponseSchema>;
