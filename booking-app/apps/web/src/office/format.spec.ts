import { describe, expect, it } from 'vitest';

import { minuteOfDay, parseMinuteOfDay } from './format.js';

/**
 * Reading a wall clock back off a form field.
 *
 * The parse is the half that matters. `minuteOfDay` renders a number the office never
 * typed; `parseMinuteOfDay` takes something a person typed, and anything it accepts is
 * saved as a schedule. So the interesting cases are all rejections.
 */
describe('parseMinuteOfDay', () => {
  it('reads a wall clock as minutes from midnight', () => {
    expect(parseMinuteOfDay('09:00')).toBe(540);
    expect(parseMinuteOfDay('9:05')).toBe(545);
    expect(parseMinuteOfDay('00:00')).toBe(0);
    expect(parseMinuteOfDay(' 18:30 ')).toBe(1110);
  });

  it('accepts 24:00, which is how a shift ending at midnight is written', () => {
    expect(parseMinuteOfDay('24:00')).toBe(1440);
  });

  it('rejects a minute component past 59', () => {
    // The one that was getting through: `09:75` sums to a legal 615, so a total-only
    // check saved it as 10:15 — a start time nobody entered, rendered back as something
    // plausible enough that the office would not notice.
    expect(parseMinuteOfDay('09:75')).toBeNull();
    expect(parseMinuteOfDay('09:60')).toBeNull();
    expect(parseMinuteOfDay('00:99')).toBeNull();
  });

  it('rejects anything past the end of the day', () => {
    expect(parseMinuteOfDay('24:01')).toBeNull();
    expect(parseMinuteOfDay('25:00')).toBeNull();
  });

  it('rejects what is not a wall clock at all', () => {
    for (const value of ['', '9', '09:0', '09:000', '0900', '09-00', 'ab:cd', '-1:00']) {
      expect(parseMinuteOfDay(value), value).toBeNull();
    }
  });

  it('round-trips every minute of the day', () => {
    for (let minute = 0; minute <= 1440; minute += 1) {
      expect(parseMinuteOfDay(minuteOfDay(minute)), String(minute)).toBe(minute);
    }
  });
});
