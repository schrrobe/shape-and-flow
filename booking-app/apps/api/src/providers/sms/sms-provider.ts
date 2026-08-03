import type { Locale, NotificationKindValue } from '../notification-kind.js';

export const SMS_PROVIDER = 'SMS_PROVIDER';

/**
 * Three concatenated segments. GSM-7 extension characters consume two septets;
 * any character outside GSM-7 switches the whole message to UCS-2.
 *
 * Checked before the API call, not after: an over-long body is billed per segment,
 * so failing locally is cheaper than discovering it on an invoice. German copy is
 * the binding constraint — it is consistently longer than the English.
 */
export const SMS_GSM7_MAX_SEPTETS = 459;
export const SMS_UCS2_MAX_CODE_UNITS = 201;

/** Legacy GSM-7 ceiling; encoding-aware validation uses {@link smsBodyMetrics}. */
export const SMS_MAX_LENGTH = SMS_GSM7_MAX_SEPTETS;

const GSM7_BASIC_CHARACTERS = new Set(
  Array.from(
    `@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ !"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà`,
  ),
);
const GSM7_EXTENSION_CHARACTERS = new Set(['\f', '^', '{', '}', '\\', '[', '~', ']', '|', '€']);

export interface SmsBodyMetrics {
  encoding: 'GSM-7' | 'UCS-2';
  units: number;
  limit: number;
}

/** Count the billable units after selecting the encoding for the whole body. */
export function smsBodyMetrics(body: string): SmsBodyMetrics {
  let septets = 0;

  for (const character of body) {
    if (GSM7_BASIC_CHARACTERS.has(character)) {
      septets += 1;
    } else if (GSM7_EXTENSION_CHARACTERS.has(character)) {
      septets += 2;
    } else {
      return { encoding: 'UCS-2', units: body.length, limit: SMS_UCS2_MAX_CODE_UNITS };
    }
  }

  return { encoding: 'GSM-7', units: septets, limit: SMS_GSM7_MAX_SEPTETS };
}

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

/**
 * Whether a provider failure is worth retrying.
 *
 * The distinction matters: retrying an invalid phone number wastes attempts and
 * delays the notification's final FAILED state, while giving up on a 503 loses a
 * reminder that would have gone through a minute later.
 */
export type DeliveryFailureClass = 'RETRYABLE' | 'PERMANENT';
