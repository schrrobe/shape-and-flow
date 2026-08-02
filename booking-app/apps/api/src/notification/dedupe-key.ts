import type { NotificationChannel, NotificationKind } from '../prisma/client.js';

/** Stands in for a booking id or a discriminator that is absent. */
const NONE = '-';

/**
 * The deterministic key a notification is deduplicated on.
 *
 * `<kind>:<channel>:<bookingId>:<discriminator>`, and the unique index on the column is
 * what turns at-least-once outbox delivery into effectively-once *contact*. The outbox
 * guarantees a `booking.confirmed` job runs at least once; without this, "at least once"
 * would mean a customer occasionally receiving two identical confirmations.
 *
 * The discriminator is what makes the key precise enough to be useful. A reminder carries
 * the appointment's `startsAt` epoch seconds, so moving the appointment produces a
 * genuinely new reminder rather than one the dedupe swallows. A decision notification
 * carries the request id, so a second cancellation request about the same booking gets
 * its own message.
 */
export function dedupeKey(
  kind: NotificationKind,
  channel: NotificationChannel,
  bookingId: string | null,
  discriminator?: string,
): string {
  return [kind, channel, bookingId ?? NONE, discriminator ?? NONE].join(':');
}
