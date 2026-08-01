import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import { REDACT_CENSOR, REDACT_PATHS } from './redaction.js';

/**
 * Asserts the promise the redaction list makes, by logging an object that
 * contains every sensitive value and then searching the serialised line for each
 * one. A path list that merely *looks* right is worth nothing; this fails if any
 * value survives.
 */

function captureLine(payload: object): string {
  const lines: string[] = [];

  const logger = pino(
    { level: 'info', redact: { paths: [...REDACT_PATHS], censor: REDACT_CENSOR, remove: false } },
    { write: (chunk: string) => void lines.push(chunk) },
  );

  logger.info(payload, 'request');
  return lines.join('');
}

/** Every secret below is a distinctive literal, so a match cannot be accidental. */
const SECRETS = {
  authorization: 'Bearer secret-token-value',
  cookie: 'sf_office_session=session-cookie-value',
  idempotencyKey: 'idem-key-11111111',
  password: 'current-hunter2',
  newPassword: 'next-hunter3',
  currentPassword: 'previous-hunter1',
  email: 'anna@example.com',
  phone: '+4915112345678',
  customerNote: 'strictly-private-note',
  tokenHash: 'deadbeefdeadbeef',
  token: 'plaintext-management-token',
  managementToken: 'mgmt-9x7q-plaintext',
};

describe('log redaction', () => {
  it('removes every credential, token and personal field from a request log', () => {
    const line = captureLine({
      req: {
        headers: {
          authorization: SECRETS.authorization,
          cookie: SECRETS.cookie,
          'idempotency-key': SECRETS.idempotencyKey,
        },
        body: {
          password: SECRETS.password,
          newPassword: SECRETS.newPassword,
          currentPassword: SECRETS.currentPassword,
          customerNote: SECRETS.customerNote,
          customer: { email: SECRETS.email, phone: SECRETS.phone },
        },
      },
      tokenHash: SECRETS.tokenHash,
      token: SECRETS.token,
      managementToken: SECRETS.managementToken,
    });

    for (const [field, value] of Object.entries(SECRETS)) {
      expect(line, `${field} leaked into the log line`).not.toContain(value);
    }

    expect(line).toContain(REDACT_CENSOR);
  });

  it('redacts a customer note and contact details at the top level too', () => {
    // Notification and booking payloads are logged flat, not under `req`.
    const line = captureLine({
      email: SECRETS.email,
      phone: SECRETS.phone,
      customerNote: SECRETS.customerNote,
      idempotencyKey: SECRETS.idempotencyKey,
    });

    for (const value of [
      SECRETS.email,
      SECRETS.phone,
      SECRETS.customerNote,
      SECRETS.idempotencyKey,
    ]) {
      expect(line).not.toContain(value);
    }
  });

  it('redacts the management token out of a job payload', () => {
    // The plaintext token travels in the booking.confirmed payload so the email
    // can contain the link. Whoever reads it in a log can cancel the booking, and
    // `*.token` does not match the field name.
    const line = captureLine({
      job: 'booking.confirmed',
      data: { bookingId: 'clx-booking-1', managementToken: SECRETS.managementToken },
    });

    expect(line).not.toContain(SECRETS.managementToken);
    expect(line).toContain('clx-booking-1');
  });

  it('redacts one level of nesting, which is how domain objects are logged', () => {
    const line = captureLine({
      customer: { email: SECRETS.email, phone: SECRETS.phone },
      booking: { customerNote: SECRETS.customerNote },
      management: { token: SECRETS.token, tokenHash: SECRETS.tokenHash },
    });

    for (const value of Object.values(SECRETS)) {
      if (line.includes(value)) expect.fail(`nested value leaked: ${value}`);
    }
  });

  it('leaves non-sensitive context intact, so logs stay useful', () => {
    const line = captureLine({
      bookingId: 'clx-booking-1',
      reference: 'SF-7K3QD2',
      status: 'CONFIRMED',
      correlationId: 'corr-1',
    });

    expect(line).toContain('clx-booking-1');
    expect(line).toContain('SF-7K3QD2');
    expect(line).toContain('CONFIRMED');
    expect(line).toContain('corr-1');
  });

  it('accepts every declared path — pino rejects a malformed one at construction', () => {
    // fast-redact throws on an invalid or duplicated path, so simply building the
    // logger is the assertion.
    expect(() =>
      pino({ redact: { paths: [...REDACT_PATHS], censor: REDACT_CENSOR } }),
    ).not.toThrow();
  });

  it('declares no duplicate paths', () => {
    expect(new Set(REDACT_PATHS).size).toBe(REDACT_PATHS.length);
  });
});
