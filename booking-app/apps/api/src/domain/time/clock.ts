import { Injectable } from '@nestjs/common';

/**
 * The current time, as a dependency.
 *
 * Nothing outside this directory may call `new Date()` or `Date.now()` — an
 * ESLint rule enforces it. Reservation expiry, the free-cancellation window and
 * the minimum-notice rule are all "now" comparisons, and a test that cannot
 * control "now" can only assert them by sleeping.
 */
export interface Clock {
  now(): Date;
}

export const CLOCK = 'CLOCK';

@Injectable()
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** A clock frozen at one instant, for tests and for deterministic jobs. */
export class FixedClock implements Clock {
  constructor(private instant: Date) {}

  now(): Date {
    return this.instant;
  }

  set(instant: Date): void {
    this.instant = instant;
  }

  advanceMinutes(minutes: number): void {
    this.instant = new Date(this.instant.getTime() + minutes * 60_000);
  }
}
