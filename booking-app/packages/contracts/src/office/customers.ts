import { z } from 'zod';

import { auditActionSchema, bookingStatusSchema } from '../enums.js';
import { cursorPageSchema, cursorQuerySchema } from '../pagination.js';
import { cuidSchema, isoInstantSchema, localeSchema, moneySchema } from '../primitives.js';

/**
 * Customers, and the audit log that records what the office did to them.
 *
 * The two live together because they are answers to the same kind of question — "what
 * happened to this person's record, and who did it" — and because erasing a customer is
 * the one office action whose whole point is that the audit row outlives the data.
 */

export const officeCustomerSchema = z.object({
  id: cuidSchema,
  firstName: z.string(),
  lastName: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  locale: localeSchema,
  /** Office-authored, never shown to the customer. */
  internalNote: z.string().nullable(),
  marketingConsentAt: isoInstantSchema.nullable(),
  archivedAt: isoInstantSchema.nullable(),
  createdAt: isoInstantSchema,
});

export type OfficeCustomer = z.infer<typeof officeCustomerSchema>;

export const customerListQuerySchema = cursorQuerySchema.extend({
  /** Matches last name, first name, email or phone. */
  q: z.string().trim().min(1).max(120).optional(),
});

export type CustomerListQuery = z.infer<typeof customerListQuerySchema>;

export const customerListResponseSchema = cursorPageSchema(officeCustomerSchema);
export type CustomerListResponse = z.infer<typeof customerListResponseSchema>;

/** One line of history on the customer's profile. */
export const customerBookingSchema = z.object({
  id: cuidSchema,
  reference: z.string(),
  status: bookingStatusSchema,
  startsAt: isoInstantSchema,
  serviceName: z.string(),
  employeeId: cuidSchema,
  price: moneySchema,
});

export const officeCustomerDetailSchema = officeCustomerSchema.extend({
  bookings: z.array(customerBookingSchema),
  /** What the customer has ever paid, card and cash together, minus settled refunds. */
  lifetimeValue: moneySchema,
});

export type OfficeCustomerDetail = z.infer<typeof officeCustomerDetailSchema>;

export const updateCustomerSchema = z
  .object({
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    email: z.email().max(320),
    phone: z.string().trim().max(50).nullable(),
    locale: localeSchema,
    internalNote: z.string().trim().max(4000).nullable(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, {
    message: 'the patch must change at least one field',
    path: [],
  });

export type UpdateCustomerRequest = z.infer<typeof updateCustomerSchema>;

/**
 * The result of erasing a customer.
 *
 * Pseudonymisation, not deletion. The bookings stay — they are the business's own
 * record of what it sold and to whom it owes tax — but everything that identifies the
 * person is replaced. `bookingsRetained` is returned so the office can see that the
 * history it still needs survived.
 */
export const eraseCustomerResponseSchema = z.object({
  customerId: cuidSchema,
  erasedAt: isoInstantSchema,
  bookingsRetained: z.number().int(),
});

export type EraseCustomerResponse = z.infer<typeof eraseCustomerResponseSchema>;

/* ── audit log ────────────────────────────────────────────────────────────────── */

export const auditLogEntrySchema = z.object({
  id: cuidSchema,
  action: auditActionSchema,
  entityType: z.string(),
  entityId: z.string(),
  summary: z.string(),
  officeUserId: cuidSchema.nullable(),
  officeUserName: z.string().nullable(),
  correlationId: z.string().nullable(),
  ipAddress: z.string().nullable(),
  createdAt: isoInstantSchema,
});

export type AuditLogEntry = z.infer<typeof auditLogEntrySchema>;

export const auditLogQuerySchema = cursorQuerySchema.extend({
  action: auditActionSchema.optional(),
  officeUserId: cuidSchema.optional(),
  entityType: z.string().trim().max(60).optional(),
  entityId: z.string().trim().max(60).optional(),
});

export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;

export const auditLogResponseSchema = cursorPageSchema(auditLogEntrySchema);
export type AuditLogResponse = z.infer<typeof auditLogResponseSchema>;
