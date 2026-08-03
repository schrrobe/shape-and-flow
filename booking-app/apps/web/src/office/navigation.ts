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
  label: string;
  /** Hidden when the signed-in user does not hold this. */
  capability: Capability;
}

export const NAVIGATION: readonly NavigationEntry[] = [
  { name: 'office-dashboard', label: 'Overview', capability: 'booking.view' },
  { name: 'office-calendar', label: 'Calendar', capability: 'booking.view' },
  { name: 'office-bookings', label: 'Bookings', capability: 'booking.view' },
  // `reschedule.decide` rather than `cancellation.decide`: §10.5 lets an employee decide
  // reschedule requests for their own bookings, so the queue is not owner-and-admin-only.
  { name: 'office-requests', label: 'Requests', capability: 'reschedule.decide' },
  { name: 'office-employees', label: 'Team', capability: 'catalog.manage' },
  { name: 'office-services', label: 'Treatments', capability: 'catalog.manage' },
  { name: 'office-availability', label: 'Availability', capability: 'availability.manage' },
  // §10.5 has no row for the customer list. Of the two plausible readings this takes the
  // stricter one — an employee needs the customer on the appointment in front of them, not
  // the whole address book.
  { name: 'office-customers', label: 'Customers', capability: 'catalog.manage' },
  { name: 'office-exports', label: 'Exports', capability: 'export.csv' },
  { name: 'office-users', label: 'Users', capability: 'users.manage' },
  { name: 'office-settings', label: 'Settings', capability: 'settings.edit' },
];
