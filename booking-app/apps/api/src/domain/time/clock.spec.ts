import { describe, expect, it } from 'vitest';

import { FixedClock, SystemClock } from './clock.js';

describe('Clock', () => {
  it('returns a real current instant from SystemClock', () => {
    const before = Date.now();
    const value = new SystemClock().now().getTime();
    const after = Date.now();

    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(after);
  });

  it('keeps FixedClock deterministic while allowing explicit movement', () => {
    const clock = new FixedClock(new Date('2026-08-02T10:00:00.000Z'));

    expect(clock.now().toISOString()).toBe('2026-08-02T10:00:00.000Z');
    clock.advanceMinutes(15);
    expect(clock.now().toISOString()).toBe('2026-08-02T10:15:00.000Z');
    clock.set(new Date('2026-08-03T12:00:00.000Z'));
    expect(clock.now().toISOString()).toBe('2026-08-03T12:00:00.000Z');
  });
});
