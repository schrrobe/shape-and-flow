import { describe, expect, it } from 'vitest';

import { coveringIntervals, uncoveredBookings } from './schedule-coverage.js';

import type { EmployeeSnapshot } from '../domain/availability/types.js';

/**
 * Coverage, as a pure function.
 *
 * The integration suite proves the endpoint reports the right appointments; this proves
 * the two cases it cannot reach cheaply — a break splitting a shift, and the two local
 * times a year that cannot be placed on the timeline at all.
 */

const ZONE = 'Europe/Berlin';

/** Mon–Fri 09:00–18:00 with a 12:00–12:30 break, which is the seeded rota. */
function employee(overrides: Partial<EmployeeSnapshot> = {}): EmployeeSnapshot {
  return {
    employeeId: 'employee-1',
    workingHours: [
      {
        weekday: 'MONDAY',
        startMinute: 540,
        endMinute: 1080,
        breaks: [{ startMinute: 720, endMinute: 750 }],
      },
    ],
    exceptions: [],
    timeOffDates: [],
    busy: [],
    ...overrides,
  };
}

/** A Berlin wall clock in summer, when the offset is UTC+2. */
function at(date: string, hourMinute: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = hourMinute.split(':').map(Number);

  return new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1, (hour ?? 0) - 2, minute ?? 0));
}

function booking(date: string, from: string, to: string) {
  return { blockStartsAt: at(date, from), blockEndsAt: at(date, to) };
}

/** 2026-08-17 is a Monday. */
const MONDAY = '2026-08-17';
const TUESDAY = '2026-08-18';

describe('coveringIntervals', () => {
  it('splits the day at the break', () => {
    const pieces = coveringIntervals(employee(), MONDAY, ZONE);

    expect(pieces).toHaveLength(2);
    expect(pieces[0]?.end.toISOString()).toBe(at(MONDAY, '12:00').toISOString());
    expect(pieces[1]?.start.toISOString()).toBe(at(MONDAY, '12:30').toISOString());
  });

  it('covers nothing on a weekday with no segment', () => {
    expect(coveringIntervals(employee(), TUESDAY, ZONE)).toEqual([]);
  });

  it('lets an EXTRA_HOURS exception replace the weekday rather than extend it', () => {
    const pieces = coveringIntervals(
      employee({
        exceptions: [{ date: MONDAY, kind: 'EXTRA_HOURS', startMinute: 600, endMinute: 660 }],
      }),
      MONDAY,
      ZONE,
    );

    // One hour, not the usual nine plus an hour: "these hours", not "these as well".
    expect(pieces).toHaveLength(1);
    expect(pieces[0]?.start.toISOString()).toBe(at(MONDAY, '10:00').toISOString());
    expect(pieces[0]?.end.toISOString()).toBe(at(MONDAY, '11:00').toISOString());
  });

  it('empties the day for a CLOSED exception', () => {
    const pieces = coveringIntervals(
      employee({
        exceptions: [{ date: MONDAY, kind: 'CLOSED', startMinute: null, endMinute: null }],
      }),
      MONDAY,
      ZONE,
    );

    expect(pieces).toEqual([]);
  });

  it('covers nothing when a shift bound falls in the spring-forward gap', () => {
    // 2026-03-29 is a Sunday on which the Berlin clock jumps 02:00 to 03:00, so a shift
    // starting at 02:30 has a bound that never happens. Reporting no coverage is the
    // same answer the availability engine gives, which is what keeps an appointment
    // there from being silently kept.
    const pieces = coveringIntervals(
      employee({
        workingHours: [{ weekday: 'SUNDAY', startMinute: 150, endMinute: 600, breaks: [] }],
      }),
      '2026-03-29',
      ZONE,
    );

    expect(pieces).toEqual([]);
  });
});

describe('uncoveredBookings', () => {
  it('keeps an appointment that fits inside a stretch', () => {
    expect(uncoveredBookings([booking(MONDAY, '09:00', '09:35')], employee(), ZONE)).toEqual([]);
  });

  it('reports one that straddles the break', () => {
    // Half in the morning stretch and half in the afternoon one is not "mostly
    // covered" — the whole block has to fit in a single piece.
    const straddling = booking(MONDAY, '11:45', '12:15');

    expect(uncoveredBookings([straddling], employee(), ZONE)).toEqual([straddling]);
  });

  it('reports one whose buffer overruns the end of the shift', () => {
    // The customer leaves at 18:00 and the employee still has five minutes of cleanup,
    // which is time the shift no longer has.
    const overrunning = booking(MONDAY, '17:30', '18:05');

    expect(uncoveredBookings([overrunning], employee(), ZONE)).toEqual([overrunning]);
  });

  it('accepts a block that ends exactly at closing time', () => {
    expect(uncoveredBookings([booking(MONDAY, '17:25', '18:00')], employee(), ZONE)).toEqual([]);
  });

  it('reports everything on a day the rota does not cover', () => {
    const orphan = booking(TUESDAY, '10:00', '10:35');

    expect(uncoveredBookings([orphan], employee(), ZONE)).toEqual([orphan]);
  });
});
