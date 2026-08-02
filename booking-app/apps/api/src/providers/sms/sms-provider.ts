import type { Locale, NotificationKindValue } from '../notification-kind.js';

export const SMS_PROVIDER = 'SMS_PROVIDER';

/**
 * Three GSM-7 segments.
 *
 * Checked before the API call, not after: an over-long body is billed per segment,
 * so failing locally is cheaper than discovering it on an invoice. German copy is
 * the binding constraint — it is consistently longer than the English.
 */
export const SMS_MAX_LENGTH = 480;

export interface SmsMessage {
  /** E.164, because Twilio rejects anything else. */
  to: string;
  body: string;
  kind: NotificationKindValue;
  locale: Locale;
}

export interface SmsSendResult {
  providerMessageId: string;
}

export interface SmsProvider {
  send(message: SmsMessage): Promise<SmsSendResult>;
}
