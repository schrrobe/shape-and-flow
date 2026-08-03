import { beforeEach, describe, expect, it } from 'vitest';

import { FakeEmailProvider } from './email/fake-email.provider.js';
import { FakeSmsProvider } from './sms/fake-sms.provider.js';

import type { EmailMessage } from './email/email-provider.js';
import type { SmsMessage } from './sms/sms-provider.js';

const email = (overrides: Partial<EmailMessage> = {}): EmailMessage => ({
  to: 'anna@example.com',
  subject: 'Ihre Buchung ist bestätigt',
  text: 'Termin am 14.08.2026 um 09:00 Uhr.',
  html: '<p>Termin am 14.08.2026 um 09:00 Uhr.</p>',
  kind: 'BOOKING_CONFIRMATION',
  locale: 'de',
  ...overrides,
});

const sms = (overrides: Partial<SmsMessage> = {}): SmsMessage => ({
  to: '+4915112345678',
  body: 'Erinnerung: Termin am 14.08.2026 um 09:00 Uhr.',
  kind: 'REMINDER_24H',
  locale: 'de',
  ...overrides,
});

describe('FakeEmailProvider', () => {
  let provider: FakeEmailProvider;

  beforeEach(() => {
    provider = new FakeEmailProvider();
  });

  it('records the whole message, which is how e2e reads the manage link', async () => {
    const result = await provider.send(
      email({ text: 'Verwalten: https://booking.example.com/manage#tok-123' }),
    );

    expect(result.providerMessageId).toMatch(/^email_fake_/);
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]).toMatchObject({
      to: 'anna@example.com',
      kind: 'BOOKING_CONFIRMATION',
      locale: 'de',
    });
    expect(provider.sent[0]?.text).toContain('/manage#tok-123');
  });

  it('returns a distinct id per message', async () => {
    const first = await provider.send(email());
    const second = await provider.send(email());
    expect(second.providerMessageId).not.toBe(first.providerMessageId);
  });

  it('filters by recipient, including the most recent', async () => {
    await provider.send(email({ to: 'anna@example.com', subject: 'first' }));
    await provider.send(email({ to: 'buero@example.com' }));
    await provider.send(email({ to: 'anna@example.com', subject: 'second' }));

    expect(provider.to('anna@example.com')).toHaveLength(2);
    expect(provider.lastTo('anna@example.com')?.subject).toBe('second');
    expect(provider.lastTo('nobody@example.com')).toBeUndefined();
  });

  it('fails exactly the next send and records nothing for it', async () => {
    provider.failNextWith(new Error('gateway'));

    await expect(provider.send(email())).rejects.toThrow('gateway');
    expect(provider.sent).toHaveLength(0);

    await expect(provider.send(email())).resolves.toBeDefined();
    expect(provider.sent).toHaveLength(1);
  });

  it('accepts a text-only message', async () => {
    await expect(provider.send(email({ html: undefined }))).resolves.toBeDefined();
  });

  it('reset clears the outbox', async () => {
    await provider.send(email());
    provider.reset();
    expect(provider.sent).toEqual([]);
  });
});

describe('FakeSmsProvider', () => {
  let provider: FakeSmsProvider;

  beforeEach(() => {
    provider = new FakeSmsProvider();
  });

  it('records the message and returns an id', async () => {
    const result = await provider.send(sms());

    expect(result.providerMessageId).toMatch(/^sms_fake_/);
    expect(provider.to('+4915112345678')).toHaveLength(1);
  });

  it('accepts 459 GSM-7 septets and rejects 460', async () => {
    await expect(provider.send(sms({ body: 'x'.repeat(459) }))).resolves.toBeDefined();
    await expect(provider.send(sms({ body: 'x'.repeat(460) }))).rejects.toThrow(/459/);
  });

  it('counts GSM-7 extension characters as two septets', async () => {
    await expect(provider.send(sms({ body: '^'.repeat(229) }))).resolves.toBeDefined();
    await expect(provider.send(sms({ body: '^'.repeat(230) }))).rejects.toThrow(/459/);
  });

  it('accepts 201 UCS-2 code units and rejects 202', async () => {
    await expect(provider.send(sms({ body: '漢'.repeat(201) }))).resolves.toBeDefined();
    await expect(provider.send(sms({ body: '漢'.repeat(202) }))).rejects.toThrow(/201/);
  });

  it('fails exactly the next send', async () => {
    provider.failNextWith(new Error('21211'));

    await expect(provider.send(sms())).rejects.toThrow('21211');
    await expect(provider.send(sms())).resolves.toBeDefined();
  });
});
