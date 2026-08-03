import { describe, expect, it } from 'vitest';

import { selectEmployee } from './select-employee.js';

import type { EmployeeCandidate } from './select-employee.js';

const candidate = (
  employeeId: string,
  bookingsThatDay: number,
  displayOrder: number,
): EmployeeCandidate => ({ employeeId, bookingsThatDay, displayOrder });

describe('selectEmployee', () => {
  it('prefers the fewest bookings that day, spreading load across the team', () => {
    expect(selectEmployee([candidate('b', 3, 0), candidate('a', 1, 9)])).toBe('a');
  });

  it('breaks a load tie on display order, honouring the business ordering', () => {
    expect(selectEmployee([candidate('b', 2, 1), candidate('a', 2, 0)])).toBe('a');
  });

  it('breaks a further tie on employee id, so the result is total', () => {
    expect(selectEmployee([candidate('b', 2, 0), candidate('a', 2, 0)])).toBe('a');
  });

  it('is stable regardless of the order candidates arrive in', () => {
    // Two identical requests must produce the same booking, or nobody can explain
    // to a customer why they are seeing a different therapist.
    const tied = ['a', 'b', 'c'] as const;
    const permutations = [
      ['a', 'b', 'c'],
      ['a', 'c', 'b'],
      ['b', 'a', 'c'],
      ['b', 'c', 'a'],
      ['c', 'a', 'b'],
      ['c', 'b', 'a'],
    ] as const;

    for (const order of permutations) {
      const candidates = order.map((id) => candidate(id, 2, 0));
      expect(selectEmployee(candidates), order.join('')).toBe(tied[0]);
    }
  });

  it('does not mutate the list it is given', () => {
    const candidates = [candidate('c', 5, 0), candidate('a', 1, 0)];
    const before = candidates.map((entry) => entry.employeeId);

    selectEmployee(candidates);

    expect(candidates.map((entry) => entry.employeeId)).toEqual(before);
  });

  it('returns the only candidate when there is one', () => {
    expect(selectEmployee([candidate('solo', 12, 7)])).toBe('solo');
  });

  it('lets load beat display order, not the other way round', () => {
    // The employee first in display order is busiest, so someone else takes it.
    expect(selectEmployee([candidate('first', 4, 0), candidate('second', 0, 1)])).toBe('second');
  });

  it('throws rather than returning undefined for an empty list', () => {
    // The caller resolves "any available employee" before inserting a row, so an
    // empty candidate set means the slot is gone — not that a null employee is
    // acceptable.
    expect(() => selectEmployee([])).toThrow(/No employee is available/);
    expect(() => selectEmployee([])).toThrow(
      expect.objectContaining({ code: 'NO_EMPLOYEE_AVAILABLE', status: 409 }),
    );
  });

  it('handles a realistic team without surprises', () => {
    const team = [
      candidate('mara', 3, 0),
      candidate('jonas', 3, 1),
      candidate('ines', 2, 2),
      candidate('tom', 5, 3),
    ];
    expect(selectEmployee(team)).toBe('ines');
  });
});
