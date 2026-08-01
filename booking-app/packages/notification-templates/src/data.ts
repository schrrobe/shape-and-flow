import type { AppointmentData, CommonData, NotificationKind, TemplateData } from './types.js';

/**
 * Realistic fixtures for every kind.
 *
 * Shared by the tests and by anyone reviewing copy by eye, which is why the values are
 * plausible rather than `foo`: a snapshot full of placeholders is one nobody reads
 * carefully, and reading these carefully once is how a mistranslation gets caught.
 *
 * The appointment is Friday 14 August 2026, 09:00–09:30 Berlin — the same instant the
 * integration suites use, so a snapshot and a test failure describe the same booking.
 */
const STARTS_AT = new Date('2026-08-14T07:00:00.000Z');
const ENDS_AT = new Date('2026-08-14T07:30:00.000Z');

const COMMON: CommonData = {
  businessName: 'Shape and Flow',
  businessPhone: '+49 30 1234567',
  addressLine: 'Beispielstraße 1, 10115 Berlin',
  businessEmail: 'hallo@shape-and-flow.example',
};

const APPOINTMENT: AppointmentData = {
  ...COMMON,
  reference: 'SF-7K3QD2',
  serviceName: 'Rückenmassage 30 Minuten',
  employeeName: 'Mara Vogt',
  startsAt: STARTS_AT,
  endsAt: ENDS_AT,
  priceCents: 4500,
  currency: 'EUR',
  customerFirstName: 'Anna',
};

const MANAGE_URL = 'https://booking.shape-and-flow.example/manage#tok_sample';

/**
 * The fixture for one kind.
 *
 * Typed so each branch is checked against that kind's own contract — a field renamed in
 * `TemplateData` breaks this file, which is where a missing fixture should surface rather
 * than as `undefined` inside a rendered email.
 */
export function sampleDataFor<K extends NotificationKind>(kind: K): TemplateData[K] {
  return SAMPLES[kind];
}

const SAMPLES: { [K in NotificationKind]: TemplateData[K] } = {
  BOOKING_CONFIRMATION: {
    ...APPOINTMENT,
    manageUrl: MANAGE_URL,
    freeCancellationUntil: new Date('2026-08-11T07:00:00.000Z'),
  },
  BOOKING_CANCELED_BY_CUSTOMER: {
    ...APPOINTMENT,
    refundedCents: 4500,
    retainedCents: 0,
  },
  BOOKING_CANCELED_BY_BUSINESS: {
    ...APPOINTMENT,
    reason: 'Krankheit im Team',
    refundedCents: 4500,
  },
  BOOKING_RESCHEDULED: {
    ...APPOINTMENT,
    manageUrl: MANAGE_URL,
    previousStartsAt: new Date('2026-08-13T07:00:00.000Z'),
  },
  REMINDER_24H: { ...APPOINTMENT, manageUrl: MANAGE_URL },
  CANCELLATION_REQUEST_RECEIVED: { ...APPOINTMENT, suggestedRetainedCents: 2250 },
  CANCELLATION_REQUEST_DECIDED: {
    ...APPOINTMENT,
    approved: true,
    retainedCents: 1000,
    refundedCents: 3500,
    note: 'Kulanz, halbe Gebühr',
  },
  RESCHEDULE_REQUEST_RECEIVED: {
    ...APPOINTMENT,
    requestedStartsAt: new Date('2026-08-21T07:00:00.000Z'),
  },
  RESCHEDULE_REQUEST_DECIDED: {
    ...APPOINTMENT,
    approved: true,
    manageUrl: MANAGE_URL,
    note: null,
  },
  REFUND_ISSUED: { ...APPOINTMENT, refundedCents: 4500 },
  OFFICE_NEW_BOOKING: {
    ...APPOINTMENT,
    customerName: 'Anna Becker',
    customerEmail: 'anna@example.com',
    customerPhone: '+49 151 12345678',
    customerNote: 'Erstbesuch, Verspannungen im Schulterbereich',
  },
  OFFICE_CANCELLATION_REQUEST: {
    ...APPOINTMENT,
    customerName: 'Anna Becker',
    suggestedRetainedCents: 2250,
    reason: 'krank geworden',
  },
  OFFICE_PASSWORD_RESET: {
    ...COMMON,
    officeUserName: 'Mara Vogt',
    resetUrl: 'https://booking.shape-and-flow.example/office/passwort/reset#tok_sample',
    expiresAt: new Date('2026-08-01T10:00:00.000Z'),
  },
};
