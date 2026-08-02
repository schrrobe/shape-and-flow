import { z } from 'zod';

import {
  cuidSchema,
  isoInstantSchema,
  localDateSchema,
  localeSchema,
  moneySchema,
} from '../primitives.js';

/**
 * The unauthenticated surface: what a booking page may ask for, and what it gets.
 *
 * Two rules shape every schema here. Nothing accepts an organization identifier —
 * the tenant is resolved server-side, and a schema that accepted one would make
 * that a lie. And every response is written out field by field rather than derived
 * from a model, so a column added later cannot leak by default: no customer data,
 * no employee email, no internal booking id.
 */

/** The widest range one availability request may cover. */
export const AVAILABILITY_MAX_RANGE_DAYS = 31;

/**
 * Days between two local dates, both inclusive of their own midnight.
 *
 * Plain UTC arithmetic is correct here even though the dates are local: both
 * endpoints are parsed as UTC midnight, so the difference is a whole number of days
 * regardless of what the organization's zone did in between.
 */
function daysBetween(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000;
}

/**
 * Query for `GET /public/availability`.
 *
 * Unknown keys are stripped, which is what makes an `organizationId` parameter
 * supplied by a client change nothing rather than being rejected — it is not an
 * error to send one, it simply has no meaning.
 */
export const availabilityQuerySchema = z
  .object({
    serviceId: cuidSchema,
    /** Absent means "any available employee". */
    employeeId: cuidSchema.optional(),
    from: localDateSchema,
    to: localDateSchema,
  })
  .refine((value) => daysBetween(value.from, value.to) >= 0, {
    message: 'to must not be before from',
    path: ['to'],
  })
  .refine((value) => daysBetween(value.from, value.to) < AVAILABILITY_MAX_RANGE_DAYS, {
    message: `range must be at most ${String(AVAILABILITY_MAX_RANGE_DAYS)} days`,
    path: ['to'],
  });

export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;

export const slotSchema = z.object({
  /** What the customer is told. Buffers are the employee's time and are not shown. */
  startsAt: isoInstantSchema,
  endsAt: isoInstantSchema,
  /**
   * Every employee who could take this slot, so a front end can offer "any
   * employee" without a second round trip. Exactly one id when the query named one.
   */
  employeeIds: z.array(cuidSchema),
});

export const daySlotsSchema = z.object({
  date: localDateSchema,
  slots: z.array(slotSchema),
});

export const availabilityResponseSchema = z.object({
  serviceId: cuidSchema,
  /** The organization's zone, so a client can label the times it renders. */
  timezone: z.string(),
  days: z.array(daySlotsSchema),
});

export type AvailabilityResponse = z.infer<typeof availabilityResponseSchema>;

/** `GET /public/organizations/current`. Identity plus the policy a booking page needs. */
export const organizationCurrentResponseSchema = z.object({
  id: cuidSchema,
  name: z.string(),
  timezone: z.string(),
  currency: z.string().length(3),
  defaultLocale: localeSchema,
  address: z.object({
    line1: z.string(),
    line2: z.string().nullable(),
    postalCode: z.string(),
    city: z.string(),
    country: z.string(),
  }),
  contactEmail: z.string(),
  contactPhone: z.string().nullable(),
  whatsappNumber: z.string().nullable(),
  /** Policy the front end needs in order to explain itself before a request fails. */
  bookingHorizonDays: z.number().int(),
  minimumNoticeHours: z.number().int(),
  freeCancellationHours: z.number().int(),
  customerNoteEnabled: z.boolean(),
});

export type OrganizationCurrentResponse = z.infer<typeof organizationCurrentResponseSchema>;

export const publicServiceSchema = z.object({
  id: cuidSchema,
  name: z.string(),
  description: z.string().nullable(),
  durationMinutes: z.number().int(),
  /** The list price. An employee may override it — see the employees endpoint. */
  price: moneySchema,
  categoryId: cuidSchema.nullable(),
  displayOrder: z.number().int(),
});

export const serviceListResponseSchema = z.object({ items: z.array(publicServiceSchema) });
export type ServiceListResponse = z.infer<typeof serviceListResponseSchema>;

export const serviceCategoryListResponseSchema = z.object({
  items: z.array(
    z.object({
      id: cuidSchema,
      name: z.string(),
      description: z.string().nullable(),
      displayOrder: z.number().int(),
      services: z.array(publicServiceSchema),
    }),
  ),
});

export type ServiceCategoryListResponse = z.infer<typeof serviceCategoryListResponseSchema>;

export const serviceEmployeesResponseSchema = z.object({
  items: z.array(
    z.object({
      id: cuidSchema,
      displayName: z.string(),
      bio: z.string().nullable(),
      photoUrl: z.string().nullable(),
      displayOrder: z.number().int(),
      /** The effective price for this employee, override applied. */
      price: moneySchema,
    }),
  ),
});

export type ServiceEmployeesResponse = z.infer<typeof serviceEmployeesResponseSchema>;
