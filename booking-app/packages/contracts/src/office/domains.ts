import { z } from 'zod';

import { cuidSchema, isoInstantSchema } from '../primitives.js';

/**
 * The hostnames an organization's public booking flow answers under.
 *
 * The wire schema deliberately does almost no hostname validation: the API normalizes
 * and validates the hostname itself, because the stored form has to be exactly the
 * spelling the request path produces, and that reduction (lowercase, punycode, no
 * scheme, no port, no trailing dot) is not something a Zod regex can perform. All this
 * enforces is "a plausibly short, non-empty string" — enough to keep megabyte bodies and
 * obvious junk out, with the real answer coming back as `VALIDATION_FAILED`.
 */
export const organizationDomainSchema = z.object({
  id: cuidSchema,
  /** Normalized: lowercase, punycode, no scheme, no port, no trailing dot. */
  hostname: z.string(),
  isPrimary: z.boolean(),
  verifiedAt: isoInstantSchema.nullable(),
  createdAt: isoInstantSchema,
});

export type OrganizationDomainDto = z.infer<typeof organizationDomainSchema>;

export const createOrganizationDomainSchema = z.object({
  hostname: z.string().trim().min(1).max(255),
  /**
   * Whether this becomes the organization's preferred address. At most one domain per
   * organization carries it, so setting it demotes whichever one held it before.
   */
  isPrimary: z.boolean().default(false),
});

export type CreateOrganizationDomainRequest = z.infer<typeof createOrganizationDomainSchema>;

export const organizationDomainListResponseSchema = z.object({
  domains: z.array(organizationDomainSchema),
});

export type OrganizationDomainListResponse = z.infer<typeof organizationDomainListResponseSchema>;

export const organizationDomainMutationResponseSchema = z.object({
  domain: organizationDomainSchema,
});

export type OrganizationDomainMutationResponse = z.infer<
  typeof organizationDomainMutationResponseSchema
>;
