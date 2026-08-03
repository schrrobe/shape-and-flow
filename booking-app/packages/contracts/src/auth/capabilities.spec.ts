import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { can, capabilityScope, CAPABILITIES } from './capabilities.js';

import type { Capability, CapabilityScope } from './capabilities.js';
import type { OfficeUserRole } from '../enums.js';

/**
 * The matrix is checked against the plan document, not against a second copy of itself.
 *
 * A test that restates the table it is testing proves only that somebody typed the same
 * thing twice. §10.5 of the implementation plan is the specification and it does not
 * change, so reading it is the one comparison that can actually fail for the right
 * reason: a grant edited in code and not in the spec.
 */
const PLAN = resolve(process.cwd(), '../../docs/plans/phase-1-implementation-plan.md');

/**
 * Prose label to capability id.
 *
 * This mapping is the part no parser can derive — the plan names capabilities in
 * English, the code names them `<area>.<verb>`. Only the *names* are transcribed here;
 * every grant comes from the document.
 */
const LABELS: Readonly<Record<string, Capability>> = {
  'View own calendar and bookings': 'booking.view',
  "View all employees' calendars": 'calendar.viewAll',
  'Complete / no-show a booking': 'booking.complete',
  'Create a manual booking': 'booking.create',
  'Cancel a booking': 'booking.cancel',
  'Decide a cancellation request': 'cancellation.decide',
  'Decide a reschedule request': 'reschedule.decide',
  'Record a manual payment': 'payment.recordManual',
  'Issue a refund': 'refund.issue',
  'Manage employees, working hours, services': 'catalog.manage',
  'Manage blocked times / time off': 'availability.manage',
  'Manage organization settings': 'settings.edit',
  'Manage office users': 'users.manage',
  'View audit log': 'auditLog.view',
  'Export CSV': 'export.csv',
};

const ROLES: readonly OfficeUserRole[] = ['OWNER', 'ADMIN', 'EMPLOYEE'];

/**
 * The one cell §10.5 cannot express on its own.
 *
 * Its first row is "View **own** calendar and bookings — yes | yes | yes", and its
 * second withholds *all* employees' calendars from `EMPLOYEE`. So the "yes" in row one
 * means "all" for the two roles row two also grants, and "own" for the one it refuses:
 * the scope for that cell is carried by the row beside it, not by the cell. Recorded
 * here as one visible exception rather than resolved by a cleverer parser, because a
 * parser that inferred it would also infer things the plan did not say.
 */
const SCOPED_BY_A_NEIGHBOURING_ROW: Partial<
  Record<Capability, Partial<Record<OfficeUserRole, CapabilityScope>>>
> = {
  'booking.view': { EMPLOYEE: 'own' },
};

/** What one cell of the plan's table means. */
export function parseCell(cell: string): CapabilityScope {
  const value = cell.trim().toLowerCase();

  if (value === 'no') return 'none';
  if (value.includes('own')) return 'own';
  // "yes", and "with `canIssueRefunds`" — the flag is a separate axis, asserted below.
  if (value === 'yes' || value.includes('canissuerefunds')) return 'all';

  throw new Error(`unrecognised grant in the plan: "${cell}"`);
}

/** The §10.5 table, as rows of `[capability, grants]`. */
export function parseMatrix(
  document: string,
): [Capability, Record<OfficeUserRole, CapabilityScope>][] {
  const start = document.indexOf('### 10.5 Authorization matrix');
  if (start === -1) throw new Error('§10.5 is not in the plan document');

  const rows: [Capability, Record<OfficeUserRole, CapabilityScope>][] = [];

  for (const line of document.slice(start).split('\n').slice(1)) {
    if (!line.startsWith('|')) {
      // The table ends at the first line that is not one. Everything after is prose.
      if (rows.length > 0) break;
      continue;
    }

    const cells = line.split('|').slice(1, -1);
    const label = cells[0]?.trim() ?? '';

    // The header row and the `| --- |` separator.
    if (label === 'Capability' || label.startsWith('---')) continue;

    const capability = LABELS[label];
    if (capability === undefined) throw new Error(`no capability id for plan row "${label}"`);

    rows.push([
      capability,
      {
        OWNER: parseCell(cells[1] ?? ''),
        ADMIN: parseCell(cells[2] ?? ''),
        EMPLOYEE: parseCell(cells[3] ?? ''),
      },
    ]);
  }

  return rows;
}

const MATRIX = parseMatrix(readFileSync(PLAN, 'utf8'));

describe('capability matrix', () => {
  it('parsed the plan rather than nothing', () => {
    // Without this, a parser that silently found zero rows would make every assertion
    // below pass by iterating an empty list.
    expect(MATRIX).toHaveLength(15);
  });

  it('covers exactly the capabilities the plan names', () => {
    expect([...MATRIX.map(([capability]) => capability)].sort()).toEqual([...CAPABILITIES].sort());
  });

  it.each(MATRIX)('grants %s as §10.5 says', (capability, grants) => {
    for (const role of ROLES) {
      const expected = SCOPED_BY_A_NEIGHBOURING_ROW[capability]?.[role] ?? grants[role];

      // `canIssueRefunds: true` throughout, so the one conditional cell reads as the
      // "yes" the plan writes it as. The flag itself is asserted separately.
      expect(capabilityScope({ role, canIssueRefunds: true }, capability)).toBe(expected);
    }
  });

  it('withholds refunds from an admin without the flag', () => {
    expect(can({ role: 'ADMIN', canIssueRefunds: true }, 'refund.issue')).toBe(true);
    expect(can({ role: 'ADMIN', canIssueRefunds: false }, 'refund.issue')).toBe(false);
  });

  it('leaves an owner able to refund whatever the flag says', () => {
    // The API's guard reads `role === 'OWNER' || canIssueRefunds`. An owner locked out
    // of their own refunds by a flag would be a support call, not a security control.
    expect(can({ role: 'OWNER', canIssueRefunds: false }, 'refund.issue')).toBe(true);
  });

  it('does not let the flag grant anything else', () => {
    // The flag is not seniority. An employee with it set is still an employee.
    expect(can({ role: 'EMPLOYEE', canIssueRefunds: true }, 'refund.issue')).toBe(false);
    expect(can({ role: 'ADMIN', canIssueRefunds: true }, 'settings.edit')).toBe(false);
  });

  it('treats an own-only grant as permitted', () => {
    // The interface shows the button; whether a given row belongs to this employee is a
    // question about the row, and the API answers it.
    expect(capabilityScope({ role: 'EMPLOYEE', canIssueRefunds: false }, 'booking.complete')).toBe(
      'own',
    );
    expect(can({ role: 'EMPLOYEE', canIssueRefunds: false }, 'booking.complete')).toBe(true);
  });

  it('rejects a grant it does not understand', () => {
    // Proves the parser is not lenient: a plan cell reading "sometimes" must fail the
    // suite rather than quietly become one of the three known values.
    expect(() => parseCell('sometimes')).toThrow(/unrecognised/i);
  });
});
