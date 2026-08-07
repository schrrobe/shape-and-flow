import { z } from 'zod';

import { newPasswordSchema } from '../auth/index.js';
import { entityTypeSchema } from '../enums.js';
import { cuidSchema } from '../primitives.js';

const baseFields = {
  email: z.email().max(320),
  password: newPasswordSchema,
  displayName: z.string().min(1).max(70),
  contactPhone: z.string().min(1),
  whatsappNumber: z.string().min(1).optional(),
  addressLine1: z.string().min(1),
  addressLine2: z.string().min(1).optional(),
  postalCode: z.string().min(1),
  city: z.string().min(1),
  country: z.string().length(2).default('DE'),
  taxId: z.string().min(1).optional(),
  vatId: z.string().min(1).optional(),
  returnUrl: z.url().optional(),
};

const individualSchema = z
  .object({
    entityType: z.literal('INDIVIDUAL'),
    firstName: z.string().min(1).max(70),
    lastName: z.string().min(1).max(70),
    isSmallBusiness: z.literal(false).default(false),
    ...baseFields,
  })
  .strict();

const soleProprietorshipSchema = z
  .object({
    entityType: z.literal('SOLE_PROPRIETORSHIP'),
    companyName: z.string().min(1).max(110),
    firstName: z.string().min(1).max(70),
    lastName: z.string().min(1).max(70),
    isSmallBusiness: z.boolean().default(false),
    ...baseFields,
  })
  .strict();

const organizationEntitySchema = z
  .object({
    entityType: z.literal('ORGANIZATION'),
    companyName: z.string().min(1).max(110),
    isSmallBusiness: z.boolean().default(false),
    ...baseFields,
  })
  .strict();

export const registerOrganizationRequestSchema = z
  .discriminatedUnion('entityType', [
    individualSchema,
    soleProprietorshipSchema,
    organizationEntitySchema,
  ])
  .superRefine((value, ctx) => {
    if (value.isSmallBusiness && value.country !== 'DE') {
      ctx.addIssue({
        code: 'custom',
        path: ['isSmallBusiness'],
        message: 'isSmallBusiness is only available for country "DE".',
      });
    }
  });

export type RegisterOrganizationRequest = z.infer<typeof registerOrganizationRequestSchema>;

export const registerOrganizationResponseSchema = z.object({
  id: cuidSchema,
  slug: z.string(),
  onboardingLink: z.url().nullable(),
});

export type RegisterOrganizationResponse = z.infer<typeof registerOrganizationResponseSchema>;
