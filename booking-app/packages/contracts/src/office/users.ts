import { z } from 'zod';

import { officeUserSchema } from '../auth/index.js';
import { officeUserRoleSchema } from '../enums.js';
import { booleanQuery, cuidSchema, isoInstantSchema } from '../primitives.js';

/**
 * Office user management — `OWNER` only, every route.
 *
 * Two rules are worth stating because they are enforced in the service rather than by
 * a decorator, and a reader of this file should know they exist:
 *
 *  - **No password travels in.** Creating a user issues a reset link instead. An owner
 *    who types a colleague's first password knows it, and it passes through a form, a
 *    request body and whatever logs those touch — for no benefit, since the colleague
 *    has to be sent something either way.
 *  - **You cannot demote or archive yourself.** The last owner locking themselves out
 *    of their own business is not a hypothetical, and there is no support desk.
 */

export const officeUserListItemSchema = officeUserSchema.extend({
  lastLoginAt: isoInstantSchema.nullable(),
  archivedAt: isoInstantSchema.nullable(),
  /** Set while a lockout is in force, so an owner can see why somebody cannot log in. */
  lockedUntil: isoInstantSchema.nullable(),
});

export type OfficeUserListItem = z.infer<typeof officeUserListItemSchema>;

export const officeUserListQuerySchema = z.object({
  includeArchived: booleanQuery(false),
});

export const officeUserListResponseSchema = z.object({
  items: z.array(officeUserListItemSchema),
});

export type OfficeUserListResponse = z.infer<typeof officeUserListResponseSchema>;

export const createOfficeUserSchema = z.object({
  email: z.email().max(320),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  role: officeUserRoleSchema,
  /** `OWNER` has it implicitly; for the other two it is a capability, not a role. */
  canIssueRefunds: z.boolean().default(false),
  /** Links the login to a person on the calendar. Required in practice for `EMPLOYEE`. */
  employeeId: cuidSchema.nullish(),
});

export type CreateOfficeUserRequest = z.infer<typeof createOfficeUserSchema>;

/**
 * The patch. `email` is deliberately absent.
 *
 * It is the login identifier, so changing it is an account takeover in one field —
 * that deserves its own flow with a confirmation to the old address, not a key in a
 * general-purpose patch.
 */
export const updateOfficeUserSchema = z
  .object({
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    role: officeUserRoleSchema,
    canIssueRefunds: z.boolean(),
    employeeId: cuidSchema.nullable(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, {
    message: 'the patch must change at least one field',
    path: [],
  });

export type UpdateOfficeUserRequest = z.infer<typeof updateOfficeUserSchema>;

/** What a create or patch answers with, plus how many sessions the change ended. */
export const officeUserMutationResponseSchema = z.object({
  user: officeUserListItemSchema,
  /**
   * Non-zero when the change invalidated what a live session was allowed to do. A
   * session copies role and refund capability in at login, so anything that changes
   * either has to end the sessions carrying the old copy.
   */
  revokedSessions: z.number().int(),
});

export type OfficeUserMutationResponse = z.infer<typeof officeUserMutationResponseSchema>;
