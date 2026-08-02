import { notificationKindSchema } from '@shape-and-flow/booking-contracts';
import { describe, expect, it } from 'vitest';

import { sampleDataFor } from './data.js';
import { escapeHtml, formatMoneyCents } from './format.js';

import { SMS_MAX_LENGTH, render } from './index.js';

import type { Locale, NotificationKind } from './types.js';

const KINDS = notificationKindSchema.options;
const LOCALES: Locale[] = ['de', 'en'];

/** The kinds that also go out as SMS. The rest are email-only by design. */
const SMS_KINDS: NotificationKind[] = [
  'BOOKING_CONFIRMATION',
  'BOOKING_CANCELED_BY_BUSINESS',
  'BOOKING_RESCHEDULED',
  'REMINDER_24H',
];

describe('every kind renders as email', () => {
  it.each(KINDS)('%s renders in both locales', (kind) => {
    for (const locale of LOCALES) {
      const out = render(kind, 'EMAIL', locale, sampleDataFor(kind));

      expect(out.subject, `${kind}/${locale} subject`).toBeTruthy();
      expect(out.text.length, `${kind}/${locale} text`).toBeGreaterThan(20);
      expect(out.html, `${kind}/${locale} html`).toContain('<');
    }
  });

  it.each(KINDS)('%s contains no unrendered value', (kind) => {
    for (const locale of LOCALES) {
      const out = render(kind, 'EMAIL', locale, sampleDataFor(kind));

      // The failure this catches is a template reading a field the data does not have,
      // which produces a plausible-looking email with `undefined` in the middle of it.
      for (const rendered of [out.subject ?? '', out.text, out.html ?? '']) {
        expect(rendered, `${kind}/${locale}`).not.toMatch(/undefined|\[object |NaN/);
      }
      // `null` is checked separately: it appears legitimately inside escaped HTML never,
      // but "null" as a word could appear in copy, so the pattern is deliberately tight.
      expect(out.text, `${kind}/${locale}`).not.toMatch(/: null\b|\bnull,/);
    }
  });
});

describe('sms renders', () => {
  it.each(SMS_KINDS)('%s fits the segment budget in both locales', (kind) => {
    for (const locale of LOCALES) {
      const out = render(kind, 'SMS', locale, sampleDataFor(kind));

      expect(
        out.text.length,
        `${kind}/${locale} is ${String(out.text.length)} chars`,
      ).toBeLessThanOrEqual(SMS_MAX_LENGTH);
    }
  });

  it.each(SMS_KINDS)('%s carries no subject or html', (kind) => {
    const out = render(kind, 'SMS', 'de', sampleDataFor(kind));

    // An SMS has neither. Returning empty strings instead of undefined would let a bug
    // ship a message with a stray blank line.
    expect(out.subject).toBeUndefined();
    expect(out.html).toBeUndefined();
  });

  it('is longer in German than in English, which is why German set the budget', () => {
    const de = render('BOOKING_CONFIRMATION', 'SMS', 'de', sampleDataFor('BOOKING_CONFIRMATION'));
    const en = render('BOOKING_CONFIRMATION', 'SMS', 'en', sampleDataFor('BOOKING_CONFIRMATION'));

    expect(de.text.length).toBeGreaterThan(en.text.length);
  });

  it('falls back to the first block for a kind with no sms form', () => {
    // Sendable rather than an exception at send time: a kind without an SMS form is one
    // nobody chose to send that way.
    const out = render('REFUND_ISSUED', 'SMS', 'de', sampleDataFor('REFUND_ISSUED'));

    expect(out.text.length).toBeGreaterThan(0);
  });
});

describe('locale formatting', () => {
  it('formats money and dates the German way', () => {
    const out = render(
      'BOOKING_CONFIRMATION',
      'EMAIL',
      'de',
      sampleDataFor('BOOKING_CONFIRMATION'),
    );

    expect(out.text).toContain('45,00');
    expect(out.text).toMatch(/14\.08\.2026/);
    expect(out.text).toContain('09:00');
    expect(out.text).toContain('Freitag');
  });

  it('formats money the English way', () => {
    const out = render(
      'BOOKING_CONFIRMATION',
      'EMAIL',
      'en',
      sampleDataFor('BOOKING_CONFIRMATION'),
    );

    expect(out.text).toContain('45.00');
    expect(out.text).toContain('Friday');
  });

  it('renders times in the business zone, not UTC', () => {
    // 07:00Z is 09:00 in Berlin. A customer is coming to a physical address, so the only
    // useful reading is the clock on the wall there.
    const out = render('REMINDER_24H', 'EMAIL', 'de', sampleDataFor('REMINDER_24H'));

    expect(out.text).toContain('09:00');
    expect(out.text).not.toContain('07:00');
  });

  it('builds money through Intl rather than by concatenation', () => {
    // The separator, the position and the spacing all differ by locale; a template that
    // assembles them gets one of the two wrong.
    expect(formatMoneyCents(4500, 'EUR', 'de')).toMatch(/45,00/);
    expect(formatMoneyCents(4500, 'EUR', 'en')).toMatch(/45\.00/);
    expect(formatMoneyCents(0, 'EUR', 'de')).toMatch(/0,00/);
    expect(formatMoneyCents(-4500, 'EUR', 'de')).toMatch(/45,00/);
  });
});

describe('the management link', () => {
  it('appears in the body and never in the subject', () => {
    const out = render(
      'BOOKING_CONFIRMATION',
      'EMAIL',
      'de',
      sampleDataFor('BOOKING_CONFIRMATION'),
    );

    // Subjects leak into lock-screen previews and mail-client list views, which is a
    // worse place for a credential than the body.
    expect(out.text).toContain('/manage#');
    expect(out.subject).not.toContain('/manage#');
  });

  it.each(['BOOKING_CONFIRMATION', 'BOOKING_RESCHEDULED', 'REMINDER_24H'] as const)(
    '%s keeps the token out of the subject in both locales',
    (kind) => {
      for (const locale of LOCALES) {
        const out = render(kind, 'EMAIL', locale, sampleDataFor(kind));
        expect(out.subject, `${kind}/${locale}`).not.toContain('tok_sample');
      }
    },
  );
});

describe('html escaping', () => {
  it('escapes markup in an interpolated value', () => {
    const data = {
      ...sampleDataFor('BOOKING_CONFIRMATION'),
      employeeName: '<script>alert(1)</script>',
    };

    const out = render('BOOKING_CONFIRMATION', 'EMAIL', 'de', data);

    // Some of these values are typed by a customer, and an email client that renders
    // HTML is as capable of running injected markup as a browser.
    expect(out.html).not.toContain('<script>');
    expect(out.html).toContain('&lt;script&gt;');
  });

  it('escapes a customer note, which is free text', () => {
    const data = {
      ...sampleDataFor('OFFICE_NEW_BOOKING'),
      customerNote: '<img src=x onerror="alert(1)">',
    };

    const out = render('OFFICE_NEW_BOOKING', 'EMAIL', 'de', data);

    expect(out.html).not.toContain('<img');
    expect(out.html).toContain('&lt;img');
  });

  it('leaves the plain-text part unescaped, because it is not markup', () => {
    const data = { ...sampleDataFor('OFFICE_NEW_BOOKING'), customerNote: 'a < b & c' };
    const out = render('OFFICE_NEW_BOOKING', 'EMAIL', 'de', data);

    expect(out.text).toContain('a < b & c');
  });

  it('escapes ampersands before the other replacements', () => {
    // Otherwise `<` becomes `&lt;` and then the `&` in it is escaped again.
    expect(escapeHtml('<a & b>')).toBe('&lt;a &amp; b&gt;');
  });
});

describe('the plain-text part', () => {
  it('is generated from the blocks, not stripped from the html', () => {
    const out = render(
      'BOOKING_CONFIRMATION',
      'EMAIL',
      'de',
      sampleDataFor('BOOKING_CONFIRMATION'),
    );

    // Stripping tags leaves text with the shape of markup — stray whitespace, lost line
    // breaks — and this part is what a screen reader actually reads.
    expect(out.text).not.toContain('<');
    expect(out.text).not.toContain('style=');
    expect(out.text.split('\n\n').length).toBeGreaterThan(2);
  });

  it('carries the business footer in both parts', () => {
    const out = render('REMINDER_24H', 'EMAIL', 'de', sampleDataFor('REMINDER_24H'));

    expect(out.text).toContain('Beispielstraße 1');
    expect(out.html).toContain('Beispielstra');
  });
});

describe('snapshots', () => {
  it.each(KINDS)('%s matches the stored render', (kind) => {
    for (const locale of LOCALES) {
      // Snapshots so a copy change is a visible diff in review rather than a silent one.
      expect(render(kind, 'EMAIL', locale, sampleDataFor(kind))).toMatchSnapshot(
        `${kind}-${locale}`,
      );
    }
  });

  it.each(SMS_KINDS)('%s sms matches the stored render', (kind) => {
    for (const locale of LOCALES) {
      expect(render(kind, 'SMS', locale, sampleDataFor(kind)).text).toMatchSnapshot(
        `${kind}-${locale}-sms`,
      );
    }
  });
});
