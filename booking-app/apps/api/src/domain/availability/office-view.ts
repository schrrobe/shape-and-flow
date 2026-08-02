import type { AvailabilitySnapshot } from './types.js';

/**
 * The snapshot as the office's rules see it.
 *
 * Two settings, and only two, differ between what a customer may book and what the
 * business may write down for one:
 *
 *  - **Minimum notice does not apply.** An office booking somebody in two hours is the
 *    normal case — the notice window exists to stop a customer from booking a slot
 *    nobody can prepare for, not to stop the business from taking a phone call.
 *  - **The horizon does not bound it.** The horizon bounds what a customer is *offered*.
 *    A date typed by the office is a date it meant, so the value here is far enough that
 *    the engine's clamp cannot cut one off.
 *
 * Expressed by overriding settings rather than by branching around the check, so the
 * rota, breaks, closed days, approved leave, blocked times and every existing booking
 * still apply to both paths from the same code.
 *
 * Used by `GET /office/availability` to decide what to *offer* and by the reservation
 * transaction to decide what to *accept*. One definition, because a slot the office is
 * shown and then refused would be a bug nobody could explain at the desk.
 */
export function asOfficeSnapshot(snapshot: AvailabilitySnapshot): AvailabilitySnapshot {
  return {
    ...snapshot,
    settings: {
      ...snapshot.settings,
      minimumNoticeHours: 0,
      bookingHorizonDays: OFFICE_HORIZON_DAYS,
    },
  };
}

/** Ten years. Not "unbounded": the engine iterates days, and a range still has to end. */
const OFFICE_HORIZON_DAYS = 3650;
