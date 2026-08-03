import type { BookingStatus } from '../prisma/client.js';
import type { DisplayStatus } from '@shape-and-flow/booking-contracts';

/** Whether a booking has an undecided request of each kind against it. */
export interface OpenRequests {
  cancellation: boolean;
  reschedule: boolean;
}

/**
 * What to show instead of the stored status.
 *
 * `CANCELLATION_REQUESTED` and `RESCHEDULE_REQUESTED` are deliberately not booking
 * statuses. The booking stays `CONFIRMED` while the office decides, because that is what
 * keeps the slot blocked — moving it to a "requested" status would either free the slot
 * or need a second status column to remember that it should not be freed. So the two
 * facts coexist in the data, and this function is where they are collapsed for a screen.
 *
 * Cancellation wins when both are open, and the reason is what the office has to do
 * next: a cancellation decision ends the appointment, so deciding it first makes the
 * reschedule question moot, while the reverse leaves both still open.
 *
 * Only a live booking can display as requested. A request against a booking that has
 * since been cancelled or completed is stale — it can exist, because deciding a request
 * and cancelling a booking are separate actions — and showing "cancellation requested"
 * on a completed appointment would describe the request rather than the appointment.
 */
export function deriveDisplayStatus(
  booking: { status: BookingStatus },
  open: OpenRequests,
): DisplayStatus {
  if (booking.status !== 'CONFIRMED') return booking.status;

  if (open.cancellation) return 'CANCELLATION_REQUESTED';
  if (open.reschedule) return 'RESCHEDULE_REQUESTED';

  return booking.status;
}
