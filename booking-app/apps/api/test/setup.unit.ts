// NestJS decorators write to the metadata reflection API, so this import must
// happen before any decorated class is evaluated.
import 'reflect-metadata';

/**
 * A frozen instant used by every test that reasons about time.
 *
 * 2026-08-01T06:00Z is 08:00 in German summer time (UTC+2). Both DST
 * transition dates for 2026 are exported alongside it because the availability
 * engine has to be correct on them.
 */
export const FIXED_NOW = new Date('2026-08-01T06:00:00.000Z');
export const DST_SPRING_FORWARD = '2026-03-29';
export const DST_FALL_BACK = '2026-10-25';
export const BERLIN = 'Europe/Berlin';
