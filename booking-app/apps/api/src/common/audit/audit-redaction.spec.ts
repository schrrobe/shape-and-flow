import { describe, expect, it } from 'vitest';

import { REDACT_CENSOR } from '../logging/redaction.js';

import { AUDIT_REDACTED_KEYS, redactForAudit } from './audit-redaction.js';

describe('AUDIT_REDACTED_KEYS', () => {
  it('covers every field the log redaction covers', () => {
    // Derived from the same list, so a field added for pino is redacted here too. If
    // this ever has to become a hand-written list, this test is what will fail first.
    for (const key of [
      'password',
      'newPassword',
      'currentPassword',
      'token',
      'tokenHash',
      'managementToken',
      'idempotencyKey',
      'email',
      'phone',
      'emailNormalized',
      'customerNote',
      'authorization',
      'cookie',
      'set-cookie',
    ]) {
      expect(AUDIT_REDACTED_KEYS.has(key.toLowerCase()), key).toBe(true);
    }
  });

  it('does not redact the fields an audit row exists to record', () => {
    for (const key of ['id', 'status', 'amountcents', 'reason', 'role', 'startsat']) {
      expect(AUDIT_REDACTED_KEYS.has(key), key).toBe(false);
    }
  });

  it('leaves the business its own contact details', () => {
    // `contactEmail` and `contactPhone` are the organization's, printed on the booking
    // page and in every email footer — public information, not a person's. Redacting
    // them would hide exactly the change an owner reviewing the audit log wants to see,
    // while protecting nothing. A *customer's* address is `email`, which is on the list.
    expect(AUDIT_REDACTED_KEYS.has('contactemail')).toBe(false);
    expect(AUDIT_REDACTED_KEYS.has('contactphone')).toBe(false);
    expect(AUDIT_REDACTED_KEYS.has('email')).toBe(true);
  });
});

describe('redactForAudit', () => {
  it('redacts by name at any depth and keeps the shape', () => {
    const redacted = redactForAudit({
      id: 'abc',
      customer: { firstName: 'Anna', email: 'anna@example.com', phone: '+49301234567' },
      notes: [{ customerNote: 'private' }],
    });

    expect(redacted).toEqual({
      id: 'abc',
      customer: { firstName: 'Anna', email: REDACT_CENSOR, phone: REDACT_CENSOR },
      notes: [{ customerNote: REDACT_CENSOR }],
    });
  });

  it('keeps the key rather than dropping it', () => {
    // `{ email: "[Redacted]" }` says an address changed; a missing key says nothing did.
    expect(redactForAudit({ email: 'a@b.c' })).toHaveProperty('email');
  });

  it('matches case-insensitively, because a DTO may not spell it the schema way', () => {
    expect(redactForAudit({ Email: 'a@b.c', TOKEN: 'x' })).toEqual({
      Email: REDACT_CENSOR,
      TOKEN: REDACT_CENSOR,
    });
  });

  it('passes primitives, null and arrays through untouched', () => {
    expect(redactForAudit('plain')).toBe('plain');
    expect(redactForAudit(42)).toBe(42);
    expect(redactForAudit(null)).toBeNull();
    expect(redactForAudit([1, 'two'])).toEqual([1, 'two']);
  });
});
