/**
 * Turn ISO strings back into Dates.
 *
 * A notification payload went through JSON on the way in, so every Date is now a
 * string, and the templates format Dates. Converting by shape rather than by a field
 * list means a template gaining a date field does not need this function changed.
 *
 * Its own module because two callers need it: the send path, which renders a message
 * for delivery, and the test-support outbox, which re-renders the same payload to
 * show what was sent. Rendering from two slightly different revivals would make the
 * end-to-end assertions true about something nobody received.
 */
export function reviveDates(payload: unknown): unknown {
  if (typeof payload === 'string' && ISO_INSTANT.test(payload)) return new Date(payload);
  if (Array.isArray(payload)) return payload.map(reviveDates);

  if (payload === null || typeof payload !== 'object') return payload;

  return Object.fromEntries(
    Object.entries(payload as Record<string, unknown>).map(([key, value]) => [
      key,
      reviveDates(value),
    ]),
  );
}

/** Deliberately strict, so a string that merely starts with a date is left alone. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
