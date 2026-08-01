import { z } from 'zod';

import { officeUserRoleSchema } from '../enums.js';
import { cuidSchema } from '../primitives.js';

export * from './capabilities.js';

/**
 * Office authentication.
 *
 * Note what is absent: no `organizationId` anywhere. An office user's tenant comes
 * from the row the credentials matched, and from then on from the session — never
 * from anything the browser sent.
 */

/** Minimum accepted length. Long enough to matter, short enough that people comply. */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * A short deny list, checked case-insensitively.
 *
 * Deliberately small. It is a speed bump against the handful of long strings people
 * reach for when told "at least twelve characters" — not a password policy, and not
 * a substitute for the rate limit and the account lockout, which are what actually
 * make guessing expensive. Entries shorter than the minimum length would be
 * unreachable, so every one of these is twelve characters or more.
 */
export const DENIED_PASSWORDS: readonly string[] = [
  'passwordpassword',
  'password1234',
  'passwort1234',
  'administrator',
  '123456789012',
  '111111111111',
  'qwertyuiopas',
  'qwertzuiopas',
  'iloveyou1234',
  'letmeinletmein',
  'welcome12345',
  'willkommen12',
  'changeme1234',
  'geheim123456',
];

/** True when the value is *not* on the list — the direction `refine` wants. */
const isNotDenied = (value: string): boolean =>
  !DENIED_PASSWORDS.includes(value.trim().toLowerCase());

/**
 * A password being *set*, as opposed to one being presented.
 *
 * Only used where a new password is written. Login deliberately does not use it: a
 * user whose stored password predates a rule change must still be able to sign in
 * and change it, and rejecting their input with a 400 would also tell an attacker
 * that the length rule — rather than the credential — was what failed.
 */
export const newPasswordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH)
  .max(200)
  .refine(isNotDenied, 'must not be a commonly used password');

export const loginRequestSchema = z.object({
  email: z.email().max(320),
  // Any non-empty string. See newPasswordSchema.
  password: z.string().min(1).max(200),
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;

/**
 * The authenticated user, as the office SPA knows them.
 *
 * `canIssueRefunds` is sent because the interface has to hide the refund button, and
 * `employeeId` because an EMPLOYEE's calendar is their own. Neither is authorisation:
 * both are re-checked server-side on every request that depends on them.
 */
export const officeUserSchema = z.object({
  id: cuidSchema,
  email: z.email(),
  firstName: z.string(),
  lastName: z.string(),
  role: officeUserRoleSchema,
  canIssueRefunds: z.boolean(),
  employeeId: cuidSchema.nullable(),
});

export type OfficeUserDto = z.infer<typeof officeUserSchema>;

export const loginResponseSchema = z.object({ user: officeUserSchema });
export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const passwordResetRequestSchema = z.object({ email: z.email().max(320) });

export type PasswordResetRequest = z.infer<typeof passwordResetRequestSchema>;

export const passwordResetConfirmSchema = z.object({
  token: z.string().min(1).max(200),
  newPassword: newPasswordSchema,
});

export type PasswordResetConfirmRequest = z.infer<typeof passwordResetConfirmSchema>;

export const changePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: newPasswordSchema,
});

export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;
