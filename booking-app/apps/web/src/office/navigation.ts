import type { Capability } from '@shape-and-flow/booking-contracts';

/**
 * The office sidebar, as data.
 *
 * A table rather than markup, so the capability filter can be tested without mounting a
 * layout — and so the set of destinations is enumerable. A hand-written sidebar is where
 * a link to a screen somebody's role cannot open survives for months.
 */
export interface NavigationEntry {
  /** Route name, so a path change moves the link with it. */
  name: string;
  /** i18n key, resolved against the office message namespace at render time. */
  labelKey: string;
  /** Hidden when the signed-in user does not hold this. */
  capability: Capability;
}

export const NAVIGATION: readonly NavigationEntry[] = [
  { name: 'office-dashboard', labelKey: 'office.nav.overview', capability: 'booking.view' },
  { name: 'office-calendar', labelKey: 'office.nav.calendar', capability: 'booking.view' },
  { name: 'office-bookings', labelKey: 'office.nav.bookings', capability: 'booking.view' },
  // `reschedule.decide` rather than `cancellation.decide`: §10.5 lets an employee decide
  // reschedule requests for their own bookings, so the queue is not owner-and-admin-only.
  { name: 'office-requests', labelKey: 'office.nav.requests', capability: 'reschedule.decide' },
  { name: 'office-employees', labelKey: 'office.nav.team', capability: 'catalog.manage' },
  { name: 'office-services', labelKey: 'office.nav.treatments', capability: 'catalog.manage' },
  {
    name: 'office-availability',
    labelKey: 'office.nav.availability',
    capability: 'availability.manage',
  },
  // §10.5 has no row for the customer list. Of the two plausible readings this takes the
  // stricter one — an employee needs the customer on the appointment in front of them, not
  // the whole address book.
  { name: 'office-customers', labelKey: 'office.nav.customers', capability: 'catalog.manage' },
  { name: 'office-exports', labelKey: 'office.nav.exports', capability: 'export.csv' },
  { name: 'office-users', labelKey: 'office.nav.users', capability: 'users.manage' },
  { name: 'office-settings', labelKey: 'office.nav.settings', capability: 'settings.edit' },
  // `settings.edit` rather than a capability of its own: it is the one row §10.5 grants to
  // OWNER alone, which is exactly who the endpoint behind this page admits. A `payment.view`
  // row would mean amending the §10.5 table the capability tests parse, for a page whose
  // audience is already spelled out by an existing row.
  { name: 'office-payments', labelKey: 'office.nav.payments', capability: 'settings.edit' },
];
