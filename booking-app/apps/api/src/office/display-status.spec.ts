import { describe, expect, it } from 'vitest';

import { BookingStatus } from '../prisma/client.js';

import { deriveDisplayStatus } from './display-status.js';

const NONE = { cancellation: false, reschedule: false };

describe('deriveDisplayStatus', () => {
  it('passes every stored status through when nothing is open', () => {
    // Exhaustive over the enum, so a status added later cannot quietly acquire a
    // display status nobody chose for it.
    for (const status of Object.values(BookingStatus)) {
      expect(deriveDisplayStatus({ status }, NONE), status).toBe(status);
    }
  });

  it('shows a requested state while the booking itself stays CONFIRMED', () => {
    const status = BookingStatus.CONFIRMED;

    expect(deriveDisplayStatus({ status }, { cancellation: true, reschedule: false })).toBe(
      'CANCELLATION_REQUESTED',
    );
    expect(deriveDisplayStatus({ status }, { cancellation: false, reschedule: true })).toBe(
      'RESCHEDULE_REQUESTED',
    );
  });

  it('prefers cancellation when both are open', () => {
    // Deciding the cancellation ends the appointment and makes the reschedule question
    // moot; the reverse order leaves both still open.
    expect(
      deriveDisplayStatus(
        { status: BookingStatus.CONFIRMED },
        { cancellation: true, reschedule: true },
      ),
    ).toBe('CANCELLATION_REQUESTED');
  });

  it('ignores a stale request against a booking that is no longer live', () => {
    // Deciding a request and cancelling a booking are separate actions, so an open
    // request can outlive the appointment. Showing "cancellation requested" on a
    // completed one would describe the request rather than the appointment.
    for (const status of [
      BookingStatus.COMPLETED,
      BookingStatus.CANCELED_BY_CUSTOMER,
      BookingStatus.NO_SHOW,
      BookingStatus.EXPIRED,
    ]) {
      expect(
        deriveDisplayStatus({ status }, { cancellation: true, reschedule: true }),
        status,
      ).toBe(status);
    }
  });
});
