import { can, CAPABILITIES } from '@shape-and-flow/booking-contracts';
import { describe, expect, it } from 'vitest';

import { router } from '../router/index.js';

import { NAVIGATION } from './navigation.js';

import type { CapabilitySubject } from '@shape-and-flow/booking-contracts';

/** What the sidebar would show this person. */
function visibleTo(subject: CapabilitySubject): string[] {
  return NAVIGATION.filter((entry) => can(subject, entry.capability)).map((entry) => entry.label);
}

describe('office navigation', () => {
  it('shows an owner everything', () => {
    expect(visibleTo({ role: 'OWNER', canIssueRefunds: false })).toEqual(
      NAVIGATION.map((entry) => entry.label),
    );
  });

  it('withholds users and settings from an admin', () => {
    const visible = visibleTo({ role: 'ADMIN', canIssueRefunds: true });

    expect(visible).not.toContain('Users');
    expect(visible).not.toContain('Settings');
    expect(visible).toContain('Exports');
    expect(visible).toContain('Team');
  });

  it('shows an employee their own work and nothing administrative', () => {
    // Overview, calendar, bookings and requests scoped to their own appointments, plus their
    // own availability. No team, no treatments, no customer list, no exports.
    expect(visibleTo({ role: 'EMPLOYEE', canIssueRefunds: false })).toEqual([
      'Overview',
      'Calendar',
      'Bookings',
      'Requests',
      'Availability',
    ]);
  });

  it('names each route once', () => {
    const names = NAVIGATION.map((entry) => entry.name);

    expect(new Set(names).size).toBe(names.length);
  });

  it('gates every entry on a capability that exists', () => {
    for (const entry of NAVIGATION) {
      expect(CAPABILITIES, entry.name).toContain(entry.capability);
    }
  });

  it('has no destination left unbuilt', () => {
    const missing = NAVIGATION.filter((entry) => !router.hasRoute(entry.name)).map(
      (entry) => entry.name,
    );

    // The layout hides entries whose route is not registered, which would otherwise send a
    // member of staff to the customer-facing 404. The list was how tasks 10.2 and 10.3
    // were held to shortening it; it is empty now, and an entry added without a route
    // would put itself back on it.
    expect(missing).toEqual([]);
  });
});
