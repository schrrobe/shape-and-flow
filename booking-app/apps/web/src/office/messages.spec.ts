import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { errorCodeSchema } from '@shape-and-flow/booking-contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiError, NETWORK_ERROR } from '../api/errors.js';
import { i18n } from '../i18n/index.js';

import { correlationOf, officeMessage, OFFICE_MESSAGE_KEYS } from './messages.js';

function apiError(code: Parameters<typeof errorCodeSchema.parse>[0], correlationId?: string) {
  return new ApiError({
    code: errorCodeSchema.parse(code),
    status: 409,
    ...(correlationId === undefined ? {} : { correlationId }),
  });
}

describe('office messages', () => {
  // `officeMessage` resolves through the shared i18n instance, whose default is German.
  // These assertions are all written against the English wording.
  beforeAll(() => {
    i18n.global.locale.value = 'en';
  });

  afterAll(() => {
    i18n.global.locale.value = 'de';
  });

  it('has a sentence for every error code the API can send', () => {
    // The customer side is guarded by a key-parity test across two JSON files. This is the
    // same guarantee for the office side: a code added to contracts and forgotten here
    // would render `undefined` in an alert.
    for (const key of OFFICE_MESSAGE_KEYS) {
      const message = officeMessage(
        key === NETWORK_ERROR ? new TypeError('Failed to fetch') : apiError(key),
      );

      expect(message, key).toMatch(/^[A-Z].*[.]$/);
    }
  });

  it('covers the codes contracts declares, and no more', () => {
    expect([...OFFICE_MESSAGE_KEYS].sort()).toEqual(
      [...errorCodeSchema.options, NETWORK_ERROR].sort(),
    );
  });

  it('reads as instructions to somebody who can fix the cause', () => {
    // Several codes genuinely say the same thing to both audiences — "this appointment can no
    // longer be cancelled" needs no operator translation — so identical wording is not a
    // defect. What would be one is a map that is *only* a copy, which is why this checks that
    // the office side says something of its own where it has something to add, rather than
    // demanding every line differ.
    const customer = JSON.parse(
      readFileSync(resolve(process.cwd(), 'src/i18n/en.json'), 'utf8'),
    ) as { errors: Record<string, string> };

    const operatorSpecific = ['REQUEST_ALREADY_DECIDED', 'NOT_FOUND', 'CSRF_FAILED'] as const;

    for (const code of operatorSpecific) {
      expect(officeMessage(apiError(code)), code).not.toBe(customer.errors[code]);
    }
  });

  it('falls back to the network sentence for anything that is not an ApiError', () => {
    expect(officeMessage(new TypeError('Failed to fetch'))).toMatch(/no connection/i);
    expect(officeMessage('a string')).toMatch(/no connection/i);
  });

  it('surfaces the correlation id when the server sent one', () => {
    expect(correlationOf(apiError('NOT_FOUND', 'abc-123'))).toBe('abc-123');
    expect(correlationOf(apiError('NOT_FOUND'))).toBeNull();
    expect(correlationOf(new TypeError('Failed to fetch'))).toBeNull();
  });
});
