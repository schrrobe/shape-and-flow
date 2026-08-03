import { describe, expect, it } from 'vitest';

import { generateAvailability, isSlotBookable } from './engine.js';

import type { AvailabilitySnapshot, EmployeeSnapshot } from './types.js';

const BERLIN = 'Europe/Berlin';

/** 2026-08-14 is a Friday in summer time, so 09:00 local is 07:00Z. */
const FRIDAY = '2026-08-14';
const SPRING_FORWARD = '2026-03-29'; // Sunday, 02:00 → 03:00
const FALL_BACK = '2026-10-25'; // Sunday, 03:00 → 02:00

function employee(overrides: Partial<EmployeeSnapshot> = {}): EmployeeSnapshot {
  return {
    employeeId: 'emp-1',
    workingHours: [{ weekday: 'FRIDAY', startMinute: 9 * 60, endMinute: 11 * 60, breaks: [] }],
    exceptions: [],
    timeOffDates: [],
    busy: [],
    ...overrides,
  };
}

function snapshot(overrides: Partial<AvailabilitySnapshot> = {}): AvailabilitySnapshot {
  return {
    zone: BERLIN,
    now: new Date('2026-08-01T06:00:00.000Z'),
    settings: { schedulingIntervalMinutes: 15, minimumNoticeHours: 24, bookingHorizonDays: 180 },
    service: { id: 'svc', durationMinutes: 30, prepBufferMinutes: 0, cleanupBufferMinutes: 0 },
    closedDates: [],
    employees: [employee()],
    ...overrides,
  };
}

/** Slot start instants as ISO strings, flattened across days. */
const starts = (snap: AvailabilitySnapshot, from = FRIDAY, to = FRIDAY): string[] =>
  generateAvailability(snap, from, to).days.flatMap((day) =>
    day.slots.map((slot) => slot.startsAt.toISOString()),
  );

/** Berlin-local HH:mm of every slot, which is what a customer actually sees. */
const localTimes = (snap: AvailabilitySnapshot, date: string): string[] =>
  generateAvailability(snap, date, date).days.flatMap((day) =>
    day.slots.map((slot) =>
      slot.startsAt.toLocaleTimeString('de-DE', {
        timeZone: BERLIN,
        hour: '2-digit',
        minute: '2-digit',
      }),
    ),
  );

const interval = (fromIso: string, toIso: string) => ({
  start: new Date(fromIso),
  end: new Date(toIso),
});

describe('the slot grid', () => {
  it('steps by the scheduling interval and never runs past the segment end', () => {
    // 09:00–11:00, 30-minute service, no buffers: the last slot must end by 11:00.
    expect(starts(snapshot())).toEqual([
      '2026-08-14T07:00:00.000Z',
      '2026-08-14T07:15:00.000Z',
      '2026-08-14T07:30:00.000Z',
      '2026-08-14T07:45:00.000Z',
      '2026-08-14T08:00:00.000Z',
      '2026-08-14T08:15:00.000Z',
      '2026-08-14T08:30:00.000Z',
    ]);
  });

  it('anchors the grid at the segment start, not at midnight', () => {
    const snap = snapshot({
      employees: [
        employee({
          workingHours: [
            { weekday: 'FRIDAY', startMinute: 9 * 60 + 5, endMinute: 11 * 60, breaks: [] },
          ],
        }),
      ],
    });
    // A shift starting at 09:05 offers 09:05, not 09:00 or 09:15.
    expect(starts(snap)[0]).toBe('2026-08-14T07:05:00.000Z');
    expect(starts(snap)[1]).toBe('2026-08-14T07:20:00.000Z');
  });

  it('honours other scheduling intervals', () => {
    for (const [intervalMinutes, expected] of [
      [30, 4],
      [60, 2],
      [10, 10],
    ] as const) {
      const snap = snapshot();
      snap.settings.schedulingIntervalMinutes = intervalMinutes;
      expect(starts(snap), `interval ${String(intervalMinutes)}`).toHaveLength(expected);
    }
  });

  it.each([0, -15, 2.5])('rejects an invalid scheduling interval of %s minutes', (interval) => {
    const snap = snapshot();
    snap.settings.schedulingIntervalMinutes = interval;

    expect(() => generateAvailability(snap, FRIDAY, FRIDAY)).toThrow(/positive integer/i);
  });

  it('reports customer-visible end times that exclude buffers', () => {
    const snap = snapshot({
      service: { id: 'svc', durationMinutes: 30, prepBufferMinutes: 10, cleanupBufferMinutes: 15 },
    });
    const [first] = generateAvailability(snap, FRIDAY, FRIDAY).days[0]?.slots ?? [];
    expect(first?.endsAt.getTime()).toBe((first?.startsAt.getTime() ?? 0) + 30 * 60_000);
  });

  it('offers nothing on a weekday the employee does not work', () => {
    // 2026-08-16 is a Sunday.
    expect(starts(snapshot(), '2026-08-16', '2026-08-16')).toEqual([]);
  });
});

describe('buffers', () => {
  it('keeps prep and cleanup inside the shift without moving the visible time', () => {
    const snap = snapshot({
      service: { id: 'svc', durationMinutes: 30, prepBufferMinutes: 10, cleanupBufferMinutes: 15 },
    });
    const all = starts(snap);

    // 09:00 would need prep from 08:50, before the shift, so the first slot is 09:15.
    expect(all[0]).toBe('2026-08-14T07:15:00.000Z');
    // The last slot must finish its cleanup by 11:00, so it starts at 10:15.
    expect(all.at(-1)).toBe('2026-08-14T08:15:00.000Z');
  });

  it('lets two appointments sit back-to-back when buffers exactly meet', () => {
    // An existing block occupying 09:00–09:45 (30 min + 15 min cleanup).
    const snap = snapshot({
      service: { id: 'svc', durationMinutes: 30, prepBufferMinutes: 0, cleanupBufferMinutes: 15 },
      employees: [
        employee({ busy: [interval('2026-08-14T07:00:00.000Z', '2026-08-14T07:45:00.000Z')] }),
      ],
    });
    // Half-open bounds make 09:45 legal, matching bookings_no_overlap.
    expect(starts(snap)).toContain('2026-08-14T07:45:00.000Z');
    expect(starts(snap)).not.toContain('2026-08-14T07:30:00.000Z');
  });

  it('fits a block that exactly fills the shift', () => {
    // 60-minute service plus 2 x 30 minutes of buffer is a 120-minute block, and
    // a 120-minute shift accommodates exactly one, starting at 09:30.
    const snap = snapshot({
      service: { id: 'svc', durationMinutes: 60, prepBufferMinutes: 30, cleanupBufferMinutes: 30 },
    });
    expect(localTimes(snap, FRIDAY)).toEqual(['09:30']);
  });

  it('offers nothing when the shift is shorter than the service plus buffers', () => {
    const snap = snapshot({
      service: { id: 'svc', durationMinutes: 60, prepBufferMinutes: 30, cleanupBufferMinutes: 30 },
      employees: [
        employee({
          workingHours: [
            { weekday: 'FRIDAY', startMinute: 9 * 60, endMinute: 10 * 60, breaks: [] },
          ],
        }),
      ],
    });
    expect(starts(snap)).toEqual([]);
  });
});

describe('breaks', () => {
  it('removes only the slots whose block crosses the break', () => {
    const snap = snapshot({
      employees: [
        employee({
          workingHours: [
            {
              weekday: 'FRIDAY',
              startMinute: 9 * 60,
              endMinute: 11 * 60,
              breaks: [{ startMinute: 9 * 60 + 30, endMinute: 10 * 60 }],
            },
          ],
        }),
      ],
    });
    const all = starts(snap);

    expect(all).toContain('2026-08-14T07:00:00.000Z'); // 09:00–09:30, fits before
    expect(all).not.toContain('2026-08-14T07:15:00.000Z'); // 09:15–09:45, crosses
    expect(all).not.toContain('2026-08-14T07:30:00.000Z'); // 09:30 is the break
    expect(all).not.toContain('2026-08-14T07:45:00.000Z'); // 09:45 still inside
    expect(all).toContain('2026-08-14T08:00:00.000Z'); // 10:00, after the break
  });

  it('handles several breaks in one shift', () => {
    const snap = snapshot({
      employees: [
        employee({
          workingHours: [
            {
              weekday: 'FRIDAY',
              startMinute: 9 * 60,
              endMinute: 13 * 60,
              breaks: [
                { startMinute: 10 * 60, endMinute: 10 * 60 + 30 },
                { startMinute: 12 * 60, endMinute: 12 * 60 + 30 },
              ],
            },
          ],
        }),
      ],
    });
    const local = localTimes(snap, FRIDAY);
    expect(local).toContain('09:00');
    expect(local).not.toContain('10:00');
    expect(local).toContain('10:30');
    expect(local).not.toContain('12:00');
    expect(local).toContain('12:30');
  });

  it('rejects a segment whose break cannot be placed on the DST timeline', () => {
    const snap = snapshot({
      now: new Date('2026-03-01T00:00:00.000Z'),
      employees: [
        employee({
          workingHours: [
            {
              weekday: 'SUNDAY',
              startMinute: 60,
              endMinute: 5 * 60,
              breaks: [{ startMinute: 2 * 60 + 15, endMinute: 2 * 60 + 45 }],
            },
          ],
        }),
      ],
    });

    const result = generateAvailability(snap, SPRING_FORWARD, SPRING_FORWARD);
    expect(result.days[0]?.slots).toEqual([]);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ minute: 2 * 60 + 15, reason: 'NONEXISTENT' }),
        expect.objectContaining({ minute: 2 * 60 + 45, reason: 'NONEXISTENT' }),
      ]),
    );
  });
});

describe('split shifts', () => {
  it('generates a grid per segment, each anchored at its own start', () => {
    const snap = snapshot({
      employees: [
        employee({
          workingHours: [
            { weekday: 'FRIDAY', startMinute: 9 * 60, endMinute: 10 * 60, breaks: [] },
            { weekday: 'FRIDAY', startMinute: 14 * 60, endMinute: 15 * 60, breaks: [] },
          ],
        }),
      ],
    });
    expect(localTimes(snap, FRIDAY)).toEqual([
      '09:00',
      '09:15',
      '09:30',
      '14:00',
      '14:15',
      '14:30',
    ]);
  });
});

describe('exceptions', () => {
  it('EXTRA_HOURS replaces the recurring hours rather than adding to them', () => {
    const snap = snapshot({
      employees: [
        employee({
          exceptions: [
            { date: FRIDAY, kind: 'EXTRA_HOURS', startMinute: 14 * 60, endMinute: 15 * 60 },
          ],
        }),
      ],
    });
    // The 09:00–11:00 recurring shift is gone, not supplemented.
    expect(localTimes(snap, FRIDAY)).toEqual(['14:00', '14:15', '14:30']);
  });

  it('EXTRA_HOURS opens a day the employee does not normally work', () => {
    const snap = snapshot({
      employees: [
        employee({
          exceptions: [
            { date: '2026-08-16', kind: 'EXTRA_HOURS', startMinute: 10 * 60, endMinute: 11 * 60 },
          ],
        }),
      ],
    });
    expect(localTimes(snap, '2026-08-16')).toEqual(['10:00', '10:15', '10:30']);
  });

  it('CLOSED empties the day even though the employee normally works it', () => {
    const snap = snapshot({
      employees: [
        employee({
          exceptions: [{ date: FRIDAY, kind: 'CLOSED', startMinute: null, endMinute: null }],
        }),
      ],
    });
    expect(starts(snap)).toEqual([]);
  });

  it('lets CLOSED win when both kinds exist for the same date', () => {
    const snap = snapshot({
      employees: [
        employee({
          exceptions: [
            { date: FRIDAY, kind: 'EXTRA_HOURS', startMinute: 14 * 60, endMinute: 15 * 60 },
            { date: FRIDAY, kind: 'CLOSED', startMinute: null, endMinute: null },
          ],
        }),
      ],
    });
    expect(starts(snap)).toEqual([]);
  });

  it('applies an exception only to its own date', () => {
    const snap = snapshot({
      employees: [
        employee({
          workingHours: [
            { weekday: 'FRIDAY', startMinute: 9 * 60, endMinute: 11 * 60, breaks: [] },
          ],
          exceptions: [{ date: FRIDAY, kind: 'CLOSED', startMinute: null, endMinute: null }],
        }),
      ],
    });
    expect(starts(snap, FRIDAY, FRIDAY)).toEqual([]);
    // The following Friday is unaffected.
    expect(starts(snap, '2026-08-21', '2026-08-21').length).toBeGreaterThan(0);
  });
});

describe('time off and closures', () => {
  it('approved time off empties the day for that employee only', () => {
    const snap = snapshot({
      employees: [
        employee({ employeeId: 'emp-1', timeOffDates: [FRIDAY] }),
        employee({ employeeId: 'emp-2' }),
      ],
    });
    const day = generateAvailability(snap, FRIDAY, FRIDAY).days[0];
    expect(day?.slots.length).toBeGreaterThan(0);
    for (const slot of day?.slots ?? []) {
      expect(slot.employeeIds).toEqual(['emp-2']);
    }
  });

  it('a closed day empties it for every employee', () => {
    const snap = snapshot({
      closedDates: [FRIDAY],
      employees: [employee({ employeeId: 'emp-1' }), employee({ employeeId: 'emp-2' })],
    });
    expect(starts(snap)).toEqual([]);
  });

  it('still returns the day, with no slots, so a caller can render it as closed', () => {
    const result = generateAvailability(snapshot({ closedDates: [FRIDAY] }), FRIDAY, FRIDAY);
    expect(result.days).toHaveLength(1);
    expect(result.days[0]).toEqual({ date: FRIDAY, slots: [] });
  });
});

describe('existing commitments', () => {
  it('removes slots whose block overlaps a booking or a blocked time', () => {
    // Busy 09:30–10:00 local.
    const snap = snapshot({
      employees: [
        employee({ busy: [interval('2026-08-14T07:30:00.000Z', '2026-08-14T08:00:00.000Z')] }),
      ],
    });
    const all = starts(snap);

    // 09:00–09:30 ends exactly where the busy period begins: half-open, so it survives.
    expect(all).toContain('2026-08-14T07:00:00.000Z');
    // 10:00 starts exactly where it ends, so it survives too.
    expect(all).toContain('2026-08-14T08:00:00.000Z');
    // Everything genuinely crossing it is gone.
    expect(all).not.toContain('2026-08-14T07:15:00.000Z');
    expect(all).not.toContain('2026-08-14T07:30:00.000Z');
    expect(all).not.toContain('2026-08-14T07:45:00.000Z');
  });

  it('accounts for buffers when testing against existing commitments', () => {
    const snap = snapshot({
      service: { id: 'svc', durationMinutes: 30, prepBufferMinutes: 15, cleanupBufferMinutes: 0 },
      employees: [
        employee({ busy: [interval('2026-08-14T07:30:00.000Z', '2026-08-14T08:00:00.000Z')] }),
      ],
    });
    // 10:00 would need prep from 09:45, which is inside the busy period.
    expect(starts(snap)).not.toContain('2026-08-14T08:00:00.000Z');
    // 10:15 prepares from 10:00, clear of it.
    expect(starts(snap)).toContain('2026-08-14T08:15:00.000Z');
  });
});

describe('policy windows', () => {
  it('drops slots inside the minimum-notice window', () => {
    // 24 hours notice from 09:30 on the 13th means the first bookable slot on the
    // 14th is 09:30 local.
    const snap = snapshot({ now: new Date('2026-08-13T07:30:00.000Z') });
    expect(starts(snap)[0]).toBe('2026-08-14T07:30:00.000Z');
  });

  it('offers everything when notice is zero', () => {
    const snap = snapshot({ now: new Date('2026-08-14T06:00:00.000Z') });
    snap.settings.minimumNoticeHours = 0;
    expect(starts(snap)[0]).toBe('2026-08-14T07:00:00.000Z');
  });

  it('drops dates beyond the booking horizon', () => {
    const snap = snapshot();
    snap.settings.bookingHorizonDays = 1;
    expect(starts(snap)).toEqual([]);
  });

  it('clamps the requested range to the horizon rather than refusing it', () => {
    const snap = snapshot({ now: new Date('2026-08-10T06:00:00.000Z') });
    snap.settings.bookingHorizonDays = 7;
    const days = generateAvailability(snap, '2026-08-10', '2026-08-31').days.map((day) => day.date);
    expect(days.at(0)).toBe('2026-08-10');
    expect(days.at(-1)).toBe('2026-08-17');
  });

  it('never offers a date in the past, even when asked', () => {
    const snap = snapshot({ now: new Date('2026-08-14T06:00:00.000Z') });
    const days = generateAvailability(snap, '2026-08-01', FRIDAY).days.map((day) => day.date);
    expect(days).toEqual([FRIDAY]);
  });

  it('returns nothing for an inverted range', () => {
    expect(generateAvailability(snapshot(), '2026-08-20', '2026-08-14').days).toEqual([]);
  });
});

describe('DST — spring forward', () => {
  const sundayNight = (): AvailabilitySnapshot =>
    snapshot({
      now: new Date('2026-03-01T00:00:00.000Z'),
      employees: [
        employee({
          workingHours: [{ weekday: 'SUNDAY', startMinute: 60, endMinute: 5 * 60, breaks: [] }],
        }),
      ],
    });

  it('omits the hour that does not exist instead of shifting it', () => {
    const local = localTimes(sundayNight(), SPRING_FORWARD);
    expect(local).toContain('01:00');
    expect(local).toContain('03:00');
    expect(local.filter((time) => time.startsWith('02:'))).toEqual([]);
  });

  it('reports the skipped minutes rather than hiding them', () => {
    const result = generateAvailability(sundayNight(), SPRING_FORWARD, SPRING_FORWARD);
    expect(result.skipped.length).toBeGreaterThan(0);
    for (const entry of result.skipped) {
      expect(entry.reason).toBe('NONEXISTENT');
      expect(entry.date).toBe(SPRING_FORWARD);
    }
  });

  it('keeps a 09:00 local start on both sides of the transition', () => {
    const snap = snapshot({
      now: new Date('2026-03-01T00:00:00.000Z'),
      employees: [
        employee({
          workingHours: [
            { weekday: 'MONDAY', startMinute: 9 * 60, endMinute: 10 * 60, breaks: [] },
          ],
        }),
      ],
    });
    // Same wall clock either side, different instant: CET then CEST.
    expect(starts(snap, '2026-03-23', '2026-03-23')[0]).toBe('2026-03-23T08:00:00.000Z');
    expect(starts(snap, '2026-03-30', '2026-03-30')[0]).toBe('2026-03-30T07:00:00.000Z');
  });
});

describe('DST — fall back', () => {
  const sundayNight = (): AvailabilitySnapshot =>
    snapshot({
      now: new Date('2026-10-01T00:00:00.000Z'),
      employees: [
        employee({
          workingHours: [{ weekday: 'SUNDAY', startMinute: 60, endMinute: 5 * 60, breaks: [] }],
        }),
      ],
    });

  it('omits the repeated hour rather than offering it twice', () => {
    const local = localTimes(sundayNight(), FALL_BACK);
    expect(local.filter((time) => time.startsWith('02:'))).toEqual([]);
  });

  it('emits no duplicate instants and no duplicate labels', () => {
    const iso = starts(sundayNight(), FALL_BACK, FALL_BACK);
    expect(new Set(iso).size).toBe(iso.length);

    const local = localTimes(sundayNight(), FALL_BACK);
    expect(new Set(local).size).toBe(local.length);
  });

  it('reports the skipped minutes as ambiguous, not as nonexistent', () => {
    const result = generateAvailability(sundayNight(), FALL_BACK, FALL_BACK);
    expect(result.skipped.length).toBeGreaterThan(0);
    for (const entry of result.skipped) {
      expect(entry.reason).toBe('AMBIGUOUS');
    }
  });

  it('emits slots in strictly increasing instant order across the transition', () => {
    const iso = starts(sundayNight(), FALL_BACK, FALL_BACK);
    const millis = iso.map((value) => Date.parse(value));
    expect(millis).toEqual([...millis].sort((a, b) => a - b));
  });
});

describe('multi-employee merge', () => {
  it('lists every employee who could take a slot, sorted', () => {
    const snap = snapshot({
      employees: [
        employee({ employeeId: 'emp-b' }),
        employee({
          employeeId: 'emp-a',
          busy: [interval('2026-08-14T07:00:00.000Z', '2026-08-14T07:30:00.000Z')],
        }),
      ],
    });
    const day = generateAvailability(snap, FRIDAY, FRIDAY).days[0];

    expect(day?.slots[0]?.startsAt.toISOString()).toBe('2026-08-14T07:00:00.000Z');
    expect(day?.slots[0]?.employeeIds).toEqual(['emp-b']);

    const later = day?.slots.find(
      (slot) => slot.startsAt.toISOString() === '2026-08-14T07:30:00.000Z',
    );
    expect(later?.employeeIds).toEqual(['emp-a', 'emp-b']);
  });

  it('unions differing shifts instead of intersecting them', () => {
    const snap = snapshot({
      employees: [
        employee({
          employeeId: 'morning',
          workingHours: [
            { weekday: 'FRIDAY', startMinute: 9 * 60, endMinute: 10 * 60, breaks: [] },
          ],
        }),
        employee({
          employeeId: 'afternoon',
          workingHours: [
            { weekday: 'FRIDAY', startMinute: 14 * 60, endMinute: 15 * 60, breaks: [] },
          ],
        }),
      ],
    });
    expect(localTimes(snap, FRIDAY)).toEqual([
      '09:00',
      '09:15',
      '09:30',
      '14:00',
      '14:15',
      '14:30',
    ]);
  });

  it('is deterministic regardless of the order employees are supplied in', () => {
    const forwards = snapshot({
      employees: [employee({ employeeId: 'emp-a' }), employee({ employeeId: 'emp-b' })],
    });
    const backwards = snapshot({
      employees: [employee({ employeeId: 'emp-b' }), employee({ employeeId: 'emp-a' })],
    });
    expect(JSON.stringify(generateAvailability(forwards, FRIDAY, FRIDAY))).toBe(
      JSON.stringify(generateAvailability(backwards, FRIDAY, FRIDAY)),
    );
  });

  it('returns no slots when there are no employees', () => {
    expect(starts(snapshot({ employees: [] }))).toEqual([]);
  });
});

describe('purity', () => {
  it('does not mutate the snapshot it is given', () => {
    const snap = snapshot({
      employees: [
        employee({ busy: [interval('2026-08-14T07:00:00.000Z', '2026-08-14T07:30:00.000Z')] }),
      ],
    });
    const before = JSON.stringify(snap);
    generateAvailability(snap, FRIDAY, FRIDAY);
    expect(JSON.stringify(snap)).toBe(before);
  });

  it('returns the same result when called twice', () => {
    const snap = snapshot();
    expect(JSON.stringify(generateAvailability(snap, FRIDAY, FRIDAY))).toBe(
      JSON.stringify(generateAvailability(snap, FRIDAY, FRIDAY)),
    );
  });
});

describe('isSlotBookable agrees with generateAvailability', () => {
  it('accepts every slot the engine generated, for the right employee', () => {
    const snap = snapshot({
      employees: [
        employee({ employeeId: 'emp-1' }),
        employee({
          employeeId: 'emp-2',
          busy: [interval('2026-08-14T07:00:00.000Z', '2026-08-14T07:30:00.000Z')],
        }),
      ],
    });

    for (const day of generateAvailability(snap, FRIDAY, FRIDAY).days) {
      for (const slot of day.slots) {
        for (const employeeId of slot.employeeIds) {
          expect(
            isSlotBookable(snap, employeeId, slot.startsAt),
            `${employeeId} @ ${day.date}`,
          ).toBe(true);
        }
      }
    }
  });

  it('rejects a slot for an employee that slot was not offered for', () => {
    const snap = snapshot({
      employees: [
        employee({
          employeeId: 'emp-busy',
          busy: [interval('2026-08-14T07:00:00.000Z', '2026-08-14T07:30:00.000Z')],
        }),
      ],
    });
    expect(isSlotBookable(snap, 'emp-busy', new Date('2026-08-14T07:00:00.000Z'))).toBe(false);
  });

  it('rejects an off-grid start time', () => {
    expect(isSlotBookable(snapshot(), 'emp-1', new Date('2026-08-14T07:07:00.000Z'))).toBe(false);
  });

  it('rejects a time outside the shift, on a closed day, and during time off', () => {
    expect(isSlotBookable(snapshot(), 'emp-1', new Date('2026-08-14T20:00:00.000Z'))).toBe(false);
    expect(
      isSlotBookable(
        snapshot({ closedDates: [FRIDAY] }),
        'emp-1',
        new Date('2026-08-14T07:00:00.000Z'),
      ),
    ).toBe(false);
    expect(
      isSlotBookable(
        snapshot({ employees: [employee({ timeOffDates: [FRIDAY] })] }),
        'emp-1',
        new Date('2026-08-14T07:00:00.000Z'),
      ),
    ).toBe(false);
  });

  it('rejects an unknown employee rather than throwing', () => {
    expect(isSlotBookable(snapshot(), 'nobody', new Date('2026-08-14T07:00:00.000Z'))).toBe(false);
  });

  it('rejects a slot inside the notice window and one beyond the horizon', () => {
    const soon = snapshot({ now: new Date('2026-08-14T06:00:00.000Z') });
    expect(isSlotBookable(soon, 'emp-1', new Date('2026-08-14T07:00:00.000Z'))).toBe(false);

    const narrow = snapshot();
    narrow.settings.bookingHorizonDays = 1;
    expect(isSlotBookable(narrow, 'emp-1', new Date('2026-08-14T07:00:00.000Z'))).toBe(false);
  });

  it('rejects both occurrences of the ambiguous autumn hour', () => {
    const snap = snapshot({
      now: new Date('2026-10-01T00:00:00.000Z'),
      employees: [
        employee({
          workingHours: [{ weekday: 'SUNDAY', startMinute: 60, endMinute: 5 * 60, breaks: [] }],
        }),
      ],
    });
    // 02:30 local happens twice on 2026-10-25: at 00:30Z under CEST and again at
    // 01:30Z under CET. Neither may be bookable, because neither can be described
    // unambiguously to a customer.
    expect(isSlotBookable(snap, 'emp-1', new Date('2026-10-25T00:30:00.000Z'))).toBe(false);
    expect(isSlotBookable(snap, 'emp-1', new Date('2026-10-25T01:30:00.000Z'))).toBe(false);
    // The hours either side remain bookable: 01:30 local and 03:30 local.
    expect(isSlotBookable(snap, 'emp-1', new Date('2026-10-24T23:30:00.000Z'))).toBe(true);
    expect(isSlotBookable(snap, 'emp-1', new Date('2026-10-25T02:30:00.000Z'))).toBe(true);
  });
});
