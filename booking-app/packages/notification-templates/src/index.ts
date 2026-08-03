import { deTemplates } from './de/index.js';
import { enTemplates } from './en/index.js';
import { renderLayout } from './layout.js';

import type {
  Locale,
  LocaleTemplates,
  NotificationChannel,
  NotificationKind,
  Rendered,
  TemplateData,
} from './types.js';

export * from './format.js';
export * from './types.js';
export { sampleDataFor } from './data.js';

/**
 * Three GSM-7 segments.
 *
 * Checked before the provider call rather than after: an over-long body is billed per
 * segment, so failing locally is cheaper than discovering it on an invoice. The same
 * constant lives on the SMS port; `templates.spec.ts` asserts every SMS render fits.
 */
export const SMS_MAX_LENGTH = 480;

/**
 * The registry.
 *
 * `Record<Locale, LocaleTemplates>` is the whole type-safety story: `LocaleTemplates` is a
 * mapped type over `NotificationKind`, so this object cannot be built with a kind missing
 * from either locale. Adding a kind to the enum breaks the build in two places until both
 * translations exist — which is the point, because the alternative is an English email
 * arriving at a German customer.
 */
const TEMPLATES: Record<Locale, LocaleTemplates> = {
  de: deTemplates,
  en: enTemplates,
};

/**
 * Render one notification.
 *
 * Generic over the kind so the data argument is checked against that kind's own contract:
 * passing reminder data to a refund template does not compile.
 */
export function render<K extends NotificationKind>(
  kind: K,
  channel: NotificationChannel,
  locale: Locale,
  data: TemplateData[K],
): Rendered {
  const template = TEMPLATES[locale][kind];
  const output = template(data, locale);

  if (channel === 'SMS') {
    // Falling back to the first body block rather than throwing: a kind without an SMS
    // form is one nobody chose to send by SMS, and a caller that asks anyway should get
    // something sendable rather than an exception at send time.
    const text = output.sms ?? output.blocks[0] ?? '';

    return {
      text,
      // No subject and no HTML for SMS — an SMS has neither, and returning an empty
      // string for them would let a bug ship a message with a stray blank line.
      subject: undefined,
      html: undefined,
    };
  }

  const { text, html } = renderLayout(output.blocks, data, locale);

  return { subject: output.subject, text, html };
}
