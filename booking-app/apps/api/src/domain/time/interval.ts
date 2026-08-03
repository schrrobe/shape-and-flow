/**
 * Half-open instant intervals: `[start, end)`.
 *
 * Half-open is the whole reason back-to-back appointments are legal. A booking
 * ending at 09:30 and one starting at 09:30 do not overlap, which matches both
 * the `'[)'` bounds in the `bookings_no_overlap` exclusion constraint and how a
 * studio actually runs its day. Every predicate here agrees with that constraint;
 * where they disagreed, the database would win and the UI would be lying.
 */
export interface Interval {
  readonly start: Date;
  readonly end: Date;
}

export function durationMinutes(interval: Interval): number {
  return (interval.end.getTime() - interval.start.getTime()) / 60_000;
}

/** True when an interval covers no time at all, and therefore overlaps nothing. */
export function isEmpty(interval: Interval): boolean {
  return interval.end.getTime() <= interval.start.getTime();
}

/** Half-open overlap: touching intervals do not overlap. */
export function overlaps(a: Interval, b: Interval): boolean {
  if (isEmpty(a) || isEmpty(b)) return false;
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();
}

/** True when `inner` lies entirely within `outer`, sharing bounds allowed. */
export function contains(outer: Interval, inner: Interval): boolean {
  return (
    outer.start.getTime() <= inner.start.getTime() && inner.end.getTime() <= outer.end.getTime()
  );
}

export function containsInstant(interval: Interval, instant: Date): boolean {
  return (
    interval.start.getTime() <= instant.getTime() && instant.getTime() < interval.end.getTime()
  );
}

const byStart = (a: Interval, b: Interval): number => a.start.getTime() - b.start.getTime();

/**
 * Merge overlapping and touching intervals into the smallest equivalent set.
 *
 * Touching intervals are merged: `[09:00, 09:30)` and `[09:30, 10:00)` become
 * `[09:00, 10:00)`, because as a *busy* region they describe one continuous
 * block. That is the opposite of `overlaps`, deliberately — two appointments
 * that touch are separate appointments, but two busy periods that touch are one
 * busy period.
 */
export function mergeAdjacent(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals.filter((interval) => !isEmpty(interval)).sort(byStart);

  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged.at(-1);

    if (last && interval.start.getTime() <= last.end.getTime()) {
      if (interval.end.getTime() > last.end.getTime()) {
        merged[merged.length - 1] = { start: last.start, end: interval.end };
      }
      continue;
    }

    merged.push(interval);
  }

  return merged;
}

/**
 * Remove `holes` from `from`, returning the remaining pieces in order.
 *
 * Holes may be unsorted, overlapping, or reach outside `from`; they are merged
 * first, so the caller can pass breaks, time off and existing bookings together
 * without pre-processing.
 */
export function subtract(from: Interval, holes: readonly Interval[]): Interval[] {
  if (isEmpty(from)) return [];

  const relevant = mergeAdjacent(holes.filter((hole) => overlaps(from, hole)));

  const pieces: Interval[] = [];
  let cursor = from.start;

  for (const hole of relevant) {
    if (hole.start.getTime() > cursor.getTime()) {
      pieces.push({ start: cursor, end: hole.start });
    }
    if (hole.end.getTime() > cursor.getTime()) {
      cursor = hole.end;
    }
  }

  if (cursor.getTime() < from.end.getTime()) {
    pieces.push({ start: cursor, end: from.end });
  }

  return pieces;
}
