import { describe, expect, it } from 'vitest';

import {
  addLocalDays,
  eachLocalDate,
  hasDstTransition,
  instantToLocalDate,
  instantToMinuteOfDay,
  wallClockToInstant,
  wallClockToInstantOrThrow,
  weekdayOf,
} from './local-time.js';

const BERLIN = 'Europe/Berlin';

/** 2026 DST transitions in Europe/Berlin. */
const SPRING_FORWARD = '2026-03-29'; // 02:00 → 03:00, so 02:xx does not exist
const FALL_BACK = '2026-10-25'; // 03:00 → 02:00, so 02:xx happens twice

const iso = (result: ReturnType<typeof wallClockToInstant>): string =>
  result.ok ? result.instant.toISOString() : `not-ok:${result.reason}`;

describe('wallClockToInstant on ordinary days', () => {
  it('applies the winter offset (UTC+1)', () => {
    expect(iso(wallClockToInstant('2026-01-15', 9 * 60, BERLIN))).toBe('2026-01-15T08:00:00.000Z');
  });

  it('applies the summer offset (UTC+2)', () => {
    expect(iso(wallClockToInstant('2026-07-15', 9 * 60, BERLIN))).toBe('2026-07-15T07:00:00.000Z');
  });

  it('keeps 09:00 local across the spring transition, changing the instant', () => {
    // Same wall clock, one week apart, different UTC instant. This is the whole
    // reason working hours are stored as minutes rather than as instants.
    expect(iso(wallClockToInstant('2026-03-23', 9 * 60, BERLIN))).toBe('2026-03-23T08:00:00.000Z');
    expect(iso(wallClockToInstant('2026-03-30', 9 * 60, BERLIN))).toBe('2026-03-30T07:00:00.000Z');
  });

  it('handles midnight and the last minute of the day', () => {
    expect(iso(wallClockToInstant('2026-07-15', 0, BERLIN))).toBe('2026-07-14T22:00:00.000Z');
    expect(iso(wallClockToInstant('2026-07-15', 1439, BERLIN))).toBe('2026-07-15T21:59:00.000Z');
  });

  it('treats minute 1440 as the next local midnight', () => {
    expect(iso(wallClockToInstant('2026-07-15', 1440, BERLIN))).toBe('2026-07-15T22:00:00.000Z');
  });

  it('computes minute 1440 calendar-aware, not by adding 1440 real minutes', () => {
    // The spring-forward day is only 23 hours long, so "next midnight" is 1380
    // real minutes after midnight, not 1440.
    const start = wallClockToInstant(SPRING_FORWARD, 0, BERLIN);
    const end = wallClockToInstant(SPRING_FORWARD, 1440, BERLIN);
    expect(start.ok && end.ok).toBe(true);
    if (!start.ok || !end.ok) return;
    expect((end.instant.getTime() - start.instant.getTime()) / 60_000).toBe(1380);
  });

  it('makes the fall-back day 25 hours long', () => {
    const start = wallClockToInstant(FALL_BACK, 0, BERLIN);
    const end = wallClockToInstant(FALL_BACK, 1440, BERLIN);
    expect(start.ok && end.ok).toBe(true);
    if (!start.ok || !end.ok) return;
    expect((end.instant.getTime() - start.instant.getTime()) / 60_000).toBe(1500);
  });
});

describe('wallClockToInstant across the spring-forward gap', () => {
  it('reports every minute of the missing hour as NONEXISTENT', () => {
    for (const minute of [2 * 60, 2 * 60 + 1, 2 * 60 + 30, 2 * 60 + 59]) {
      expect(wallClockToInstant(SPRING_FORWARD, minute, BERLIN)).toEqual({
        ok: false,
        reason: 'NONEXISTENT',
      });
    }
  });

  it('accepts the hours either side of the gap', () => {
    // 01:30 is before the jump, 03:30 after it. Both exist exactly once.
    expect(iso(wallClockToInstant(SPRING_FORWARD, 90, BERLIN))).toBe('2026-03-29T00:30:00.000Z');
    expect(iso(wallClockToInstant(SPRING_FORWARD, 210, BERLIN))).toBe('2026-03-29T01:30:00.000Z');
  });

  it('does not shift a valid later time, which a naive minute-addition would', () => {
    // Adding 570 real minutes to local midnight lands on 10:30, not 09:30,
    // because the day lost an hour. Constructing the wall clock directly is right.
    expect(iso(wallClockToInstant(SPRING_FORWARD, 9 * 60 + 30, BERLIN))).toBe(
      '2026-03-29T07:30:00.000Z',
    );
  });
});

describe('wallClockToInstant across the fall-back repeat', () => {
  it('reports every minute of the repeated hour as AMBIGUOUS', () => {
    for (const minute of [2 * 60, 2 * 60 + 1, 2 * 60 + 30, 2 * 60 + 59]) {
      expect(wallClockToInstant(FALL_BACK, minute, BERLIN)).toEqual({
        ok: false,
        reason: 'AMBIGUOUS',
      });
    }
  });

  it('accepts the hours either side of the repeat', () => {
    expect(iso(wallClockToInstant(FALL_BACK, 90, BERLIN))).toBe('2026-10-24T23:30:00.000Z');
    expect(iso(wallClockToInstant(FALL_BACK, 210, BERLIN))).toBe('2026-10-25T02:30:00.000Z');
  });

  it('does not confuse the repeated hour with the gap', () => {
    // Both transitions affect 02:xx, and conflating them would silently offer a
    // slot on one of the two days.
    expect(wallClockToInstant(FALL_BACK, 150, BERLIN)).toEqual({
      ok: false,
      reason: 'AMBIGUOUS',
    });
    expect(wallClockToInstant(SPRING_FORWARD, 150, BERLIN)).toEqual({
      ok: false,
      reason: 'NONEXISTENT',
    });
  });

  it('detects a 30-minute repeated interval', () => {
    expect(wallClockToInstant('2026-04-05', 1 * 60 + 45, 'Australia/Lord_Howe')).toEqual({
      ok: false,
      reason: 'AMBIGUOUS',
    });
  });
});

describe('wallClockToInstant at midnight transitions', () => {
  it('reports a skipped next midnight instead of silently moving to another date', () => {
    expect(wallClockToInstant('2011-12-29', 1440, 'Pacific/Apia')).toEqual({
      ok: false,
      reason: 'NONEXISTENT',
    });
  });
});

describe('wallClockToInstantOrThrow', () => {
  it('returns the instant on a normal day', () => {
    expect(wallClockToInstantOrThrow('2026-07-15', 9 * 60, BERLIN).toISOString()).toBe(
      '2026-07-15T07:00:00.000Z',
    );
  });

  it('throws, naming the reason, on both transition hours', () => {
    expect(() => wallClockToInstantOrThrow(SPRING_FORWARD, 150, BERLIN)).toThrow(/NONEXISTENT/);
    expect(() => wallClockToInstantOrThrow(FALL_BACK, 150, BERLIN)).toThrow(/AMBIGUOUS/);
  });
});

describe('round trips', () => {
  it('recovers the minute of day it was given', () => {
    for (const minute of [0, 90, 545, 885, 1439]) {
      const result = wallClockToInstant('2026-07-15', minute, BERLIN);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(instantToMinuteOfDay(result.instant, BERLIN)).toBe(minute);
      expect(instantToLocalDate(result.instant, BERLIN)).toBe('2026-07-15');
    }
  });

  it('reports the local date, not the UTC date, late in the evening', () => {
    // 23:30 Berlin in summer is 21:30Z on the same date; 00:30 Berlin is the
    // previous UTC day, which is where a naive UTC-based day boundary breaks.
    const late = wallClockToInstant('2026-07-15', 23 * 60 + 30, BERLIN);
    expect(late.ok && instantToLocalDate(late.instant, BERLIN)).toBe('2026-07-15');

    const early = wallClockToInstant('2026-07-15', 30, BERLIN);
    expect(early.ok && early.instant.toISOString()).toBe('2026-07-14T22:30:00.000Z');
    expect(early.ok && instantToLocalDate(early.instant, BERLIN)).toBe('2026-07-15');
  });
});

describe('validation', () => {
  it('rejects a malformed local date', () => {
    expect(() => wallClockToInstant('15-07-2026', 0, BERLIN)).toThrow(/YYYY-MM-DD/);
    expect(() => wallClockToInstant('2026-7-15', 0, BERLIN)).toThrow(/YYYY-MM-DD/);
  });

  it('rejects a date that does not exist', () => {
    expect(() => wallClockToInstant('2026-02-30', 0, BERLIN)).toThrow(/Invalid local date/);
  });

  it('rejects an unknown timezone', () => {
    expect(() => wallClockToInstant('2026-07-15', 0, 'Mars/Olympus')).toThrow(/Invalid local date/);
  });

  it('rejects a minute outside 0..1440', () => {
    expect(() => wallClockToInstant('2026-07-15', -1, BERLIN)).toThrow(/between 0 and 1440/);
    expect(() => wallClockToInstant('2026-07-15', 1441, BERLIN)).toThrow(/between 0 and 1440/);
    expect(() => wallClockToInstant('2026-07-15', 10.5, BERLIN)).toThrow(/integer/);
  });
});

describe('date helpers', () => {
  it('enumerates an inclusive range, counting a transition day once', () => {
    expect(eachLocalDate('2026-03-28', '2026-03-30', BERLIN)).toEqual([
      '2026-03-28',
      '2026-03-29',
      '2026-03-30',
    ]);
    expect(eachLocalDate('2026-10-24', '2026-10-26', BERLIN)).toEqual([
      '2026-10-24',
      '2026-10-25',
      '2026-10-26',
    ]);
  });

  it('returns a single date for an equal range and nothing for an inverted one', () => {
    expect(eachLocalDate('2026-07-15', '2026-07-15', BERLIN)).toEqual(['2026-07-15']);
    expect(eachLocalDate('2026-07-16', '2026-07-15', BERLIN)).toEqual([]);
  });

  it('crosses a month and a year boundary', () => {
    expect(eachLocalDate('2026-01-30', '2026-02-02', BERLIN)).toHaveLength(4);
    expect(eachLocalDate('2026-12-31', '2027-01-01', BERLIN)).toEqual(['2026-12-31', '2027-01-01']);
  });

  it('maps weekdays to the schema enum', () => {
    expect(weekdayOf('2026-08-14', BERLIN)).toBe('FRIDAY');
    expect(weekdayOf('2026-08-15', BERLIN)).toBe('SATURDAY');
    expect(weekdayOf('2026-08-16', BERLIN)).toBe('SUNDAY');
    expect(weekdayOf('2026-08-17', BERLIN)).toBe('MONDAY');
  });

  it('adds local days across a transition and a month end', () => {
    expect(addLocalDays('2026-03-28', 2, BERLIN)).toBe('2026-03-30');
    expect(addLocalDays('2026-01-31', 1, BERLIN)).toBe('2026-02-01');
    expect(addLocalDays('2026-03-30', -2, BERLIN)).toBe('2026-03-28');
  });

  it('identifies the two transition days and no others', () => {
    expect(hasDstTransition(SPRING_FORWARD, BERLIN)).toBe(true);
    expect(hasDstTransition(FALL_BACK, BERLIN)).toBe(true);
    expect(hasDstTransition('2026-07-15', BERLIN)).toBe(false);
    expect(hasDstTransition('2026-03-28', BERLIN)).toBe(false);
    expect(hasDstTransition('2026-03-30', BERLIN)).toBe(false);
  });
});
