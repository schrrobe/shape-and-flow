import { formatDate, formatDateTime, formatMoneyCents, formatTime } from '../format.js';

import type {
  AppointmentData,
  CancellationReasonCode,
  Locale,
  LocaleTemplates,
  TemplateData,
} from '../types.js';

const LOCALE: Locale = 'en';

function when(data: AppointmentData): string {
  return `${formatDateTime(data.startsAt, LOCALE)}–${formatTime(data.endsAt, LOCALE)}`;
}

function price(data: AppointmentData): string {
  return formatMoneyCents(data.priceCents, data.currency, LOCALE);
}

function money(cents: number, data: AppointmentData): string {
  return formatMoneyCents(cents, data.currency, LOCALE);
}

/**
 * Business-cancellation reasons, in English.
 *
 * A record rather than a switch, so adding a code to `CancellationReasonCode` is a type
 * error here until this locale has wording for it.
 */
const REASONS: Record<CancellationReasonCode, string> = {
  SEE_MESSAGE: 'see the message below',
  PAYMENT_FAILED: 'the payment could not be completed',
};

/**
 * What the customer is told about their money after a cancellation decision.
 *
 * Three outcomes, not a complicated rule, but written inline it was a ternary
 * inside a ternary in the middle of a list of sentences.
 */
function refundOutcome(data: TemplateData['CANCELLATION_REQUEST_DECIDED']): string {
  if (!data.approved) return `We look forward to seeing you.`;

  if (data.retainedCents > 0) {
    return `We are refunding ${money(data.refundedCents, data)}; a late-cancellation fee of ${money(data.retainedCents, data)} has been retained.`;
  }

  return `We are refunding the full amount of ${money(data.refundedCents, data)}.`;
}

/**
 * The English templates.
 *
 * A translation of the German, not a separate voice: the same information in the same
 * order, so a customer switching locales sees the same message. Written second precisely
 * so the German — the longer language — set the length budget.
 */
export const enTemplates: LocaleTemplates = {
  BOOKING_CONFIRMATION: (data) => ({
    subject: `Booking confirmed: ${data.serviceName} on ${formatDate(data.startsAt, LOCALE)}`,
    blocks: [
      `Hello ${data.customerFirstName},`,
      `Your appointment is confirmed. We look forward to seeing you.`,
      `${data.serviceName}\n${when(data)}\nwith ${data.employeeName}\n${price(data)}\nBooking reference ${data.reference}`,
      data.freeCancellationUntil === null
        ? `Reschedule or cancel: ${data.manageUrl}`
        : `You can cancel free of charge until ${formatDateTime(data.freeCancellationUntil, LOCALE)}. Manage your booking: ${data.manageUrl}`,
      `You will find us at ${data.addressLine}. If you have any questions, call us on ${data.businessPhone}.`,
    ],
    sms:
      `${data.businessName}: booking confirmed, ${when(data)}, ${data.serviceName} with ` +
      `${data.employeeName}. Ref ${data.reference}. Manage: ${data.manageUrl}`,
  }),

  BOOKING_CANCELED_BY_CUSTOMER: (data) => ({
    subject: `Booking cancelled: ${data.serviceName} on ${formatDate(data.startsAt, LOCALE)}`,
    blocks: [
      `Hello ${data.customerFirstName},`,
      `Your appointment on ${when(data)} has been cancelled.`,
      data.retainedCents > 0
        ? `We are refunding ${money(data.refundedCents, data)}. A late-cancellation fee of ${money(data.retainedCents, data)} has been retained.`
        : `We are refunding the full amount of ${money(data.refundedCents, data)}. Depending on your bank, it will appear within five to ten working days.`,
      `Booking reference ${data.reference}. You are welcome to book a new appointment at any time.`,
    ],
  }),

  BOOKING_CANCELED_BY_BUSINESS: (data) => ({
    subject: `We have to cancel your appointment on ${formatDate(data.startsAt, LOCALE)}`,
    blocks: [
      `Hello ${data.customerFirstName},`,
      `We are sorry to say we have to cancel your appointment on ${when(data)}. The reason: ${REASONS[data.reasonCode]}.`,
      `We sincerely apologise.`,
      data.refundedCents > 0
        ? `We are refunding ${money(data.refundedCents, data)} in full.`
        : `Nothing was charged.`,
      `Do call us on ${data.businessPhone} and we will find you a new time.`,
    ],
    sms:
      `${data.businessName}: we must cancel your appointment on ${formatDate(data.startsAt, LOCALE)} ` +
      `at ${formatTime(data.startsAt, LOCALE)}. Reason: ${REASONS[data.reasonCode]}. ` +
      `Please call us: ${data.businessPhone}`,
  }),

  BOOKING_RESCHEDULED: (data) => ({
    subject: `New time: ${data.serviceName} on ${formatDate(data.startsAt, LOCALE)}`,
    blocks: [
      `Hello ${data.customerFirstName},`,
      `Your appointment has been moved.`,
      `Previously: ${formatDateTime(data.previousStartsAt, LOCALE)}\nNow: ${when(data)}\nwith ${data.employeeName}`,
      `Booking reference ${data.reference}. The ${price(data)} you paid still stands.`,
      `Manage your booking: ${data.manageUrl}`,
    ],
    sms:
      `${data.businessName}: your appointment has moved to ${when(data)} with ` +
      `${data.employeeName}. Ref ${data.reference}. Manage: ${data.manageUrl}`,
  }),

  REMINDER_24H: (data) => ({
    // The date, not "tomorrow". One template serves every configured offset, so a
    // business running a 2-hour reminder as well sent "tomorrow" about an appointment
    // later the same day — and somebody eventually turns up a day late because of it.
    subject: `Reminder: your appointment on ${formatDate(data.startsAt, LOCALE)} at ${formatTime(data.startsAt, LOCALE)}`,
    blocks: [
      `Hello ${data.customerFirstName},`,
      `A reminder about your appointment.`,
      `${data.serviceName}\n${when(data)}\nwith ${data.employeeName}`,
      `You will find us at ${data.addressLine}.`,
      `If you cannot make it, please let us know in good time: ${data.manageUrl}`,
    ],
    sms:
      `${data.businessName}: reminder of your appointment ${when(data)}, ${data.serviceName} ` +
      `with ${data.employeeName}. Cancel: ${data.manageUrl}`,
  }),

  CANCELLATION_REQUEST_RECEIVED: (data) => ({
    subject: `Cancellation request received (${data.reference})`,
    blocks: [
      `Hello ${data.customerFirstName},`,
      `We have received your request to cancel the appointment on ${when(data)}.`,
      `Because the appointment is close, we review these personally. Likely retained: ${money(data.suggestedRetainedCents, data)} of ${price(data)}.`,
      `You will hear from us within one working day. Until then your appointment stands.`,
    ],
  }),

  CANCELLATION_REQUEST_DECIDED: (data) => ({
    subject: data.approved
      ? `Cancellation confirmed (${data.reference})`
      : `Cancellation not possible (${data.reference})`,
    blocks: [
      `Hello ${data.customerFirstName},`,
      data.approved
        ? `Your cancellation for ${when(data)} is confirmed.`
        : `We are not able to accept your cancellation for ${when(data)}. Your appointment stands.`,
      refundOutcome(data),
      data.note === null ? `Any questions: ${data.businessPhone}` : `Note: ${data.note}`,
    ],
  }),

  RESCHEDULE_REQUEST_RECEIVED: (data) => ({
    subject: `Reschedule request received (${data.reference})`,
    blocks: [
      `Hello ${data.customerFirstName},`,
      `We have received your request to move the appointment of ${when(data)}.`,
      `Requested new time: ${formatDateTime(data.requestedStartsAt, LOCALE)}.`,
      `We will look into it and get back to you. Until then your existing appointment stands.`,
    ],
  }),

  RESCHEDULE_REQUEST_DECIDED: (data) => ({
    subject: data.approved
      ? `Appointment moved (${data.reference})`
      : `Reschedule not possible (${data.reference})`,
    blocks: [
      `Hello ${data.customerFirstName},`,
      data.approved
        ? `Your appointment has been moved. New time: ${when(data)} with ${data.employeeName}.`
        : `We are not able to move your appointment. It stays at ${when(data)}.`,
      data.note === null ? `Any questions: ${data.businessPhone}` : `Note: ${data.note}`,
      ...(data.manageUrl === null ? [] : [`Manage your booking: ${data.manageUrl}`]),
    ],
  }),

  REFUND_ISSUED: (data) => ({
    subject: `Refund issued (${data.reference})`,
    blocks: [
      `Hello ${data.customerFirstName},`,
      `We have refunded ${money(data.refundedCents, data)} for booking ${data.reference}.`,
      `It goes back to the original payment method and, depending on your bank, will appear within five to ten working days.`,
      `If you have any questions, call us on ${data.businessPhone}.`,
    ],
  }),

  OFFICE_NEW_BOOKING: (data) => ({
    subject: `New booking: ${data.serviceName}, ${formatDate(data.startsAt, LOCALE)}`,
    blocks: [
      `New online booking.`,
      `${data.serviceName}\n${when(data)}\n${data.employeeName}\n${price(data)}\nRef ${data.reference}`,
      `Customer: ${data.customerName}\n${data.customerEmail}${data.customerPhone === null ? '' : `\n${data.customerPhone}`}`,
      data.customerNote === null ? `No note.` : `Note: ${data.customerNote}`,
    ],
  }),

  OFFICE_CANCELLATION_REQUEST: (data) => ({
    subject: `Cancellation request: ${data.reference} (${formatDate(data.startsAt, LOCALE)})`,
    blocks: [
      `A cancellation request is waiting for your decision.`,
      `${data.customerName}\n${data.serviceName}\n${when(data)}\n${data.employeeName}\nRef ${data.reference}`,
      `Your policy suggests retaining ${money(data.suggestedRetainedCents, data)} of ${price(data)}.`,
      data.reason === null ? `No reason given.` : `Reason: ${data.reason}`,
    ],
  }),

  OFFICE_PASSWORD_RESET: (data) => ({
    subject: `Reset your password`,
    blocks: [
      `Hello ${data.officeUserName},`,
      `Use this link to set a new password: ${data.resetUrl}`,
      `The link is valid until ${formatDateTime(data.expiresAt, LOCALE)} and can be used once.`,
      `If you did not request this, ignore this message — your password stays as it is.`,
    ],
  }),
};
