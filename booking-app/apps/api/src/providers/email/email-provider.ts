import type { Locale, NotificationKindValue } from '../notification-kind.js';

/**
 * The email port.
 *
 * Rendering belongs to the templates package; this only sends what it is given.
 * `kind` travels with the message so provider-side analytics stay useful without
 * anyone having to inspect a body.
 */
export const EMAIL_PROVIDER = 'EMAIL_PROVIDER';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  /** Absent for a text-only message. */
  html?: string | undefined;
  kind: NotificationKindValue;
  locale: Locale;
}

export interface EmailSendResult {
  /** The provider's id, stored so a delivery webhook can be matched to the row. */
  providerMessageId: string;
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<EmailSendResult>;
}
