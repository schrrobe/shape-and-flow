import { describe, expect, it } from 'vitest';

import { BookingStatus } from '../prisma/client.js';

import {
  assertTransition,
  BLOCKING_BOOKING_STATUSES,
  canTransition,
  isBlocking,
  isTerminal,
  TERMINAL_BOOKING_STATUSES,
} from './booking-status.machine.js';

const ALL_STATUSES = Object.values(BookingStatus);

describe('booking status machine', () => {
  it('classifies blocking and terminal statuses without overlap', () => {
    for (const status of ALL_STATUSES) {
      expect(isBlocking(status)).toBe(BLOCKING_BOOKING_STATUSES.includes(status as never));
      expect(isTerminal(status)).toBe(TERMINAL_BOOKING_STATUSES.includes(status as never));
      expect(isBlocking(status) && isTerminal(status)).toBe(false);
    }
  });

  it('allows only pending-payment and confirmed bookings to be created', () => {
    expect(canTransition(null, BookingStatus.PENDING_PAYMENT)).toBe(true);
    expect(canTransition(null, BookingStatus.CONFIRMED)).toBe(true);

    for (const status of ALL_STATUSES.filter(
      (value) => value !== BookingStatus.PENDING_PAYMENT && value !== BookingStatus.CONFIRMED,
    )) {
      expect(canTransition(null, status)).toBe(false);
    }
  });

  it('allows the documented non-terminal transitions', () => {
    expect(canTransition(BookingStatus.PENDING_PAYMENT, BookingStatus.EXPIRING)).toBe(true);
    expect(canTransition(BookingStatus.PENDING_PAYMENT, BookingStatus.CONFIRMED)).toBe(true);
    expect(canTransition(BookingStatus.EXPIRING, BookingStatus.EXPIRED)).toBe(true);
    expect(canTransition(BookingStatus.CONFIRMED, BookingStatus.CANCELED_BY_CUSTOMER)).toBe(true);
    expect(canTransition(BookingStatus.CONFIRMED, BookingStatus.COMPLETED)).toBe(true);
  });

  it('rejects transitions out of terminal states and reports both statuses', () => {
    for (const status of TERMINAL_BOOKING_STATUSES) {
      expect(() => {
        assertTransition(status, BookingStatus.CONFIRMED);
      }).toThrow(
        expect.objectContaining({
          code: 'INVALID_STATUS_TRANSITION',
          status: 422,
          details: { from: status, to: BookingStatus.CONFIRMED },
        }),
      );
    }
  });

  it('accepts a valid transition without returning state', () => {
    assertTransition(BookingStatus.EXPIRING, BookingStatus.CONFIRMED);
  });
});
