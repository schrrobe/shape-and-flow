import type { OfficeUserRole } from '../enums.js';

/**
 * The authorization matrix, as data.
 *
 * This is §10.5 of the implementation plan in machine-readable form, and it lives in
 * contracts rather than in the web app for one reason: the office UI has to hide what
 * the API would refuse, and two hand-maintained copies of a permission table drift.
 * When they drift the failure is not a 403 — it is a button that looks available and
 * then isn't, which reads to an operator as a broken product.
 *
 * **It is not authorization.** Nothing here is consulted when a request is served; the
 * API decides with `@Roles`, `@RequiresRefundCapability` and a service-layer scope
 * check. This table exists so the interface can predict that decision. A bug here
 * shows the wrong button; it never grants anything.
 */

/**
 * Every capability the office area gates on.
 *
 * Named `<area>.<verb>` and enumerated rather than inferred from the table's keys, so
 * a capability can be iterated — the tests walk this list, which is what makes a new
 * row impossible to add without deciding all three roles.
 */
export const CAPABILITIES = [
  'booking.view',
  'calendar.viewAll',
  'booking.complete',
  'booking.create',
  'booking.cancel',
  'cancellation.decide',
  'reschedule.decide',
  'payment.recordManual',
  'refund.issue',
  'catalog.manage',
  'availability.manage',
  'settings.edit',
  'users.manage',
  'auditLog.view',
  'export.csv',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * How far a capability reaches.
 *
 * The third value is the point of having a scope at all: §10.5 has rows where an
 * `EMPLOYEE` may act, but only on their own bookings or their own availability. A
 * boolean would collapse those to "yes" and the interface would offer an employee a
 * button that 404s on somebody else's row — the API answers `NOT_FOUND` rather than
 * `FORBIDDEN_ROLE` there, deliberately, so that it does not confirm the row exists.
 */
export type CapabilityScope = 'none' | 'own' | 'all';

/**
 * The matrix itself, one entry per capability, one grant per role.
 *
 * Written out in full — no defaults, no "everything else is none". A missing role in
 * an entry would be a `TypeScript` error rather than a silent deny, because a silent
 * deny is indistinguishable from a considered one when you read it back.
 */
const GRANTS: Readonly<Record<Capability, Readonly<Record<OfficeUserRole, CapabilityScope>>>> = {
  'booking.view': { OWNER: 'all', ADMIN: 'all', EMPLOYEE: 'own' },
  'calendar.viewAll': { OWNER: 'all', ADMIN: 'all', EMPLOYEE: 'none' },
  'booking.complete': { OWNER: 'all', ADMIN: 'all', EMPLOYEE: 'own' },
  'booking.create': { OWNER: 'all', ADMIN: 'all', EMPLOYEE: 'none' },
  'booking.cancel': { OWNER: 'all', ADMIN: 'all', EMPLOYEE: 'none' },
  'cancellation.decide': { OWNER: 'all', ADMIN: 'all', EMPLOYEE: 'none' },
  'reschedule.decide': { OWNER: 'all', ADMIN: 'all', EMPLOYEE: 'own' },
  'payment.recordManual': { OWNER: 'all', ADMIN: 'all', EMPLOYEE: 'none' },
  'refund.issue': { OWNER: 'all', ADMIN: 'all', EMPLOYEE: 'none' },
  'catalog.manage': { OWNER: 'all', ADMIN: 'all', EMPLOYEE: 'none' },
  'availability.manage': { OWNER: 'all', ADMIN: 'all', EMPLOYEE: 'own' },
  'settings.edit': { OWNER: 'all', ADMIN: 'none', EMPLOYEE: 'none' },
  'users.manage': { OWNER: 'all', ADMIN: 'none', EMPLOYEE: 'none' },
  'auditLog.view': { OWNER: 'all', ADMIN: 'none', EMPLOYEE: 'none' },
  'export.csv': { OWNER: 'all', ADMIN: 'all', EMPLOYEE: 'none' },
};

/**
 * Capabilities that also need the per-user refund flag.
 *
 * A capability rather than a fourth role, because "an admin who may not issue refunds"
 * is a real thing a business asks for. `OWNER` holds it implicitly — the API's guard
 * reads `role === 'OWNER' || canIssueRefunds`, and this mirrors that expression rather
 * than paraphrasing it.
 */
const REFUND_GATED: ReadonlySet<Capability> = new Set<Capability>(['refund.issue']);

/**
 * What the check needs to know about a user.
 *
 * Structural rather than `OfficeUserDto`, so this module has no dependency on the
 * response shape — and so a session object, a list row, or a test fixture can be
 * passed without an adapter.
 */
export interface CapabilitySubject {
  role: OfficeUserRole;
  canIssueRefunds: boolean;
}

/** How far this user's grant on this capability reaches. */
export function capabilityScope(
  subject: CapabilitySubject,
  capability: Capability,
): CapabilityScope {
  const granted = GRANTS[capability][subject.role];

  if (granted === 'none') return 'none';

  if (REFUND_GATED.has(capability) && subject.role !== 'OWNER' && !subject.canIssueRefunds) {
    return 'none';
  }

  return granted;
}

/**
 * May this user do this at all?
 *
 * `'own'` counts as yes: an employee who may complete their own appointments should
 * see the button, and whether *this* appointment is theirs is a question about a row,
 * not about the user — ask `capabilityScope` and compare ids for that.
 */
export function can(subject: CapabilitySubject, capability: Capability): boolean {
  return capabilityScope(subject, capability) !== 'none';
}
