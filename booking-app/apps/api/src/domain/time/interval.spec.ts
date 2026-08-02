import { describe, expect, it } from 'vitest';

import {
  contains,
  containsInstant,
  durationMinutes,
  isEmpty,
  mergeAdjacent,
  overlaps,
  subtract,
} from './interval.js';

import type { Interval } from './interval.js';

/** Terse construction: minutes past 2026-08-14T07:00Z, which is 09:00 Berlin. */
const BASE = Date.parse('2026-08-14T07:00:00.000Z');
const at = (minutes: number): Date => new Date(BASE + minutes * 60_000);
const iv = (startMinutes: number, endMinutes: number): Interval => ({
  start: at(startMinutes),
  end: at(endMinutes),
});
const shape = (intervals: Interval[]): [number, number][] =>
  intervals.map((interval) => [
    (interval.start.getTime() - BASE) / 60_000,
    (interval.end.getTime() - BASE) / 60_000,
  ]);

describe('overlaps', () => {
  it('treats touching intervals as not overlapping', () => {
    // Half-open bounds are why back-to-back appointments are legal, and why this
    // agrees with the '[)' bounds in bookings_no_overlap.
    expect(overlaps(iv(0, 30), iv(30, 60))).toBe(false);
    expect(overlaps(iv(30, 60), iv(0, 30))).toBe(false);
  });

  it('detects a partial overlap from either side', () => {
    expect(overlaps(iv(0, 30), iv(15, 45))).toBe(true);
    expect(overlaps(iv(15, 45), iv(0, 30))).toBe(true);
  });

  it('detects containment and identity as overlap', () => {
    expect(overlaps(iv(0, 120), iv(30, 60))).toBe(true);
    expect(overlaps(iv(30, 60), iv(0, 120))).toBe(true);
    expect(overlaps(iv(0, 30), iv(0, 30))).toBe(true);
  });

  it('treats an empty interval as overlapping nothing', () => {
    // tstzrange(x, x) is empty in PostgreSQL and overlaps nothing; matching that
    // here is what keeps the engine and the constraint consistent.
    expect(overlaps(iv(30, 30), iv(0, 60))).toBe(false);
    expect(overlaps(iv(0, 60), iv(30, 30))).toBe(false);
    expect(overlaps(iv(30, 30), iv(30, 30))).toBe(false);
  });

  it('reports no overlap for disjoint intervals', () => {
    expect(overlaps(iv(0, 30), iv(60, 90))).toBe(false);
  });
});

describe('contains', () => {
  it('accepts an inner interval, including one sharing a bound', () => {
    expect(contains(iv(0, 120), iv(30, 60))).toBe(true);
    expect(contains(iv(0, 120), iv(0, 120))).toBe(true);
    expect(contains(iv(0, 120), iv(0, 30))).toBe(true);
    expect(contains(iv(0, 120), iv(90, 120))).toBe(true);
  });

  it('rejects an interval that spills past either bound', () => {
    expect(contains(iv(0, 120), iv(-15, 60))).toBe(false);
    expect(contains(iv(0, 120), iv(60, 135))).toBe(false);
  });

  it('locates an instant with half-open bounds', () => {
    expect(containsInstant(iv(0, 30), at(0))).toBe(true);
    expect(containsInstant(iv(0, 30), at(29))).toBe(true);
    // The end bound is exclusive.
    expect(containsInstant(iv(0, 30), at(30))).toBe(false);
  });
});

describe('isEmpty and durationMinutes', () => {
  it('reports emptiness for zero-length and inverted intervals', () => {
    expect(isEmpty(iv(30, 30))).toBe(true);
    expect(isEmpty(iv(60, 30))).toBe(true);
    expect(isEmpty(iv(0, 30))).toBe(false);
  });

  it('measures duration in minutes', () => {
    expect(durationMinutes(iv(0, 30))).toBe(30);
    expect(durationMinutes(iv(0, 0))).toBe(0);
  });
});

describe('mergeAdjacent', () => {
  it('merges overlapping and touching busy periods into one', () => {
    // Opposite of `overlaps` on purpose: two appointments that touch are two
    // appointments, but two busy periods that touch are one busy period.
    expect(shape(mergeAdjacent([iv(0, 30), iv(30, 60)]))).toEqual([[0, 60]]);
    expect(shape(mergeAdjacent([iv(0, 45), iv(30, 60)]))).toEqual([[0, 60]]);
  });

  it('leaves a genuine gap intact', () => {
    expect(shape(mergeAdjacent([iv(0, 30), iv(45, 60)]))).toEqual([
      [0, 30],
      [45, 60],
    ]);
  });

  it('sorts unsorted input and absorbs fully contained intervals', () => {
    expect(shape(mergeAdjacent([iv(60, 90), iv(0, 120), iv(30, 45)]))).toEqual([[0, 120]]);
  });

  it('drops empty intervals and handles an empty list', () => {
    expect(shape(mergeAdjacent([iv(30, 30)]))).toEqual([]);
    expect(shape(mergeAdjacent([]))).toEqual([]);
  });

  it('does not mutate its input', () => {
    const input = [iv(60, 90), iv(0, 30)];
    const snapshot = shape(input);
    mergeAdjacent(input);
    expect(shape(input)).toEqual(snapshot);
  });
});

describe('subtract', () => {
  it('splits around a hole in the middle', () => {
    expect(shape(subtract(iv(0, 240), [iv(120, 150)]))).toEqual([
      [0, 120],
      [150, 240],
    ]);
  });

  it('trims a hole at the leading or trailing edge', () => {
    expect(shape(subtract(iv(0, 240), [iv(0, 60)]))).toEqual([[60, 240]]);
    expect(shape(subtract(iv(0, 240), [iv(180, 240)]))).toEqual([[0, 180]]);
  });

  it('returns nothing when a hole covers the whole interval', () => {
    expect(shape(subtract(iv(0, 60), [iv(-60, 120)]))).toEqual([]);
    expect(shape(subtract(iv(0, 60), [iv(0, 60)]))).toEqual([]);
  });

  it('handles unsorted, overlapping and out-of-range holes together', () => {
    // Breaks, time off and existing bookings arrive as one unsorted list, so
    // pre-processing must not be the caller's job.
    expect(
      shape(
        subtract(iv(0, 300), [iv(180, 210), iv(60, 90), iv(75, 120), iv(400, 500), iv(-60, -30)]),
      ),
    ).toEqual([
      [0, 60],
      [120, 180],
      [210, 300],
    ]);
  });

  it('ignores a hole that merely touches a bound', () => {
    // A booking ending exactly when the shift starts removes nothing from it.
    expect(shape(subtract(iv(0, 240), [iv(-30, 0)]))).toEqual([[0, 240]]);
    expect(shape(subtract(iv(0, 240), [iv(240, 300)]))).toEqual([[0, 240]]);
  });

  it('returns the whole interval when there are no holes', () => {
    expect(shape(subtract(iv(0, 240), []))).toEqual([[0, 240]]);
  });

  it('returns nothing for an empty source interval', () => {
    expect(shape(subtract(iv(30, 30), []))).toEqual([]);
  });

  it('produces pieces that never overlap the holes it removed', () => {
    const holes = [iv(60, 90), iv(180, 210)];
    for (const piece of subtract(iv(0, 300), holes)) {
      for (const hole of holes) {
        expect(overlaps(piece, hole)).toBe(false);
      }
    }
  });
});
