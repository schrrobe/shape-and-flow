import { errorCodeSchema } from '@shape-and-flow/booking-contracts';

import { ApiError, NETWORK_ERROR } from '../api/errors.js';
import { i18n } from '../i18n/index.js';

import { registerOfficeMessages } from './i18n/index.js';

import type { MessageKey } from '../api/errors.js';

/** Every key the map must cover — the error codes, plus the one the client invents. */
export const OFFICE_MESSAGE_KEYS: readonly MessageKey[] = [
  ...errorCodeSchema.options,
  NETWORK_ERROR,
];

/**
 * The translation key for a failure, inside the office message namespace.
 *
 * A separate namespace from the customer side's `errors.*`, not an alias to it: the
 * wording differs on purpose. An operator can act on "somebody else changed this — reload
 * and try again"; a customer cannot.
 */
function officeMessageKeyFor(error: unknown): `office.errors.${MessageKey}` {
  if (error instanceof ApiError) return `office.errors.${error.code}`;

  // A `TypeError` from `fetch` means the request never got an answer.
  return `office.errors.${NETWORK_ERROR}`;
}

/** Sentence to show for a failure, in whichever locale is currently active. */
export function officeMessage(error: unknown): string {
  // Office copy is merged into the shared i18n instance lazily; a failure can be the very
  // first thing that needs a string from it, so this cannot assume a screen got there first.
  registerOfficeMessages();

  return i18n.global.t(officeMessageKeyFor(error));
}

/**
 * The correlation id, when the server sent one.
 *
 * Shown next to the message so a support conversation starts with an id instead of a
 * description. Absent for a network failure, which never reached a server to get one.
 */
export function correlationOf(error: unknown): string | null {
  return error instanceof ApiError ? (error.correlationId ?? null) : null;
}
