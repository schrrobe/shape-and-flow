import { formatDate, formatDateTime, formatMoneyCents, formatTime } from '../format.js';

import type {
  AppointmentData,
  CancellationReasonCode,
  Locale,
  LocaleTemplates,
  TemplateData,
} from '../types.js';

const LOCALE: Locale = 'de';

/** The appointment, as one quotable line. Used by almost every kind. */
function when(data: AppointmentData): string {
  return `${formatDateTime(data.startsAt, LOCALE)}–${formatTime(data.endsAt, LOCALE)} Uhr`;
}

function price(data: AppointmentData): string {
  return formatMoneyCents(data.priceCents, data.currency, LOCALE);
}

function money(cents: number, data: AppointmentData): string {
  return formatMoneyCents(cents, data.currency, LOCALE);
}

/**
 * Business-cancellation reasons, in German.
 *
 * A record rather than a switch, so adding a code to `CancellationReasonCode` is a type
 * error here until this locale has wording for it.
 */
const REASONS: Record<CancellationReasonCode, string> = {
  SEE_MESSAGE: 'siehe Nachricht',
  PAYMENT_FAILED: 'die Zahlung konnte nicht abgeschlossen werden',
};

/**
 * What the customer is told about their money after a cancellation decision.
 *
 * Three outcomes, not a complicated rule, but written inline it was a ternary
 * inside a ternary in the middle of a list of sentences.
 */
function refundOutcome(data: TemplateData['CANCELLATION_REQUEST_DECIDED']): string {
  if (!data.approved) return `Wir freuen uns, Sie zum Termin zu sehen.`;

  if (data.retainedCents > 0) {
    return `Wir erstatten ${money(data.refundedCents, data)}; einbehalten wird eine Ausfallgebühr von ${money(data.retainedCents, data)}.`;
  }

  return `Wir erstatten den vollen Betrag von ${money(data.refundedCents, data)}.`;
}

/**
 * The German templates.
 *
 * Authored before the English ones on purpose: German is consistently the longer
 * language, so if the SMS budget is met here it is met everywhere. Writing English first
 * would make the shorter text the implicit reference and the German version the one that
 * silently overflows into a second billed segment.
 *
 * `Sie` throughout — a massage studio writing to a customer it may not have met.
 */
export const deTemplates: LocaleTemplates = {
  BOOKING_CONFIRMATION: (data) => ({
    subject: `Termin bestätigt: ${data.serviceName} am ${formatDate(data.startsAt, LOCALE)}`,
    blocks: [
      `Guten Tag ${data.customerFirstName},`,
      `Ihr Termin ist bestätigt. Wir freuen uns auf Sie.`,
      `${data.serviceName}\n${when(data)}\nbei ${data.employeeName}\n${price(data)}\nBuchungsnummer ${data.reference}`,
      data.freeCancellationUntil === null
        ? `Termin verschieben oder stornieren: ${data.manageUrl}`
        : `Bis ${formatDateTime(data.freeCancellationUntil, LOCALE)} Uhr können Sie kostenfrei stornieren. Termin verwalten: ${data.manageUrl}`,
      `Sie finden uns in der ${data.addressLine}. Bei Fragen erreichen Sie uns unter ${data.businessPhone}.`,
    ],
    sms:
      `${data.businessName}: Termin bestätigt, ${when(data)}, ${data.serviceName} bei ` +
      `${data.employeeName}. Nr. ${data.reference}. Verwalten: ${data.manageUrl}`,
  }),

  BOOKING_CANCELED_BY_CUSTOMER: (data) => ({
    subject: `Termin storniert: ${data.serviceName} am ${formatDate(data.startsAt, LOCALE)}`,
    blocks: [
      `Guten Tag ${data.customerFirstName},`,
      `Ihr Termin am ${when(data)} wurde storniert.`,
      data.retainedCents > 0
        ? `Wir erstatten ${money(data.refundedCents, data)}. Einbehalten wird eine Ausfallgebühr von ${money(data.retainedCents, data)}.`
        : `Wir erstatten den vollen Betrag von ${money(data.refundedCents, data)}. Die Rückbuchung erscheint je nach Bank innerhalb von fünf bis zehn Werktagen.`,
      `Buchungsnummer ${data.reference}. Sie sind jederzeit willkommen, einen neuen Termin zu buchen.`,
    ],
  }),

  BOOKING_CANCELED_BY_BUSINESS: (data) => ({
    subject: `Wir müssen Ihren Termin am ${formatDate(data.startsAt, LOCALE)} absagen`,
    blocks: [
      `Guten Tag ${data.customerFirstName},`,
      `leider müssen wir Ihren Termin am ${when(data)} absagen. Der Grund: ${REASONS[data.reasonCode]}.`,
      `Das tut uns aufrichtig leid.`,
      data.refundedCents > 0
        ? `Wir erstatten ${money(data.refundedCents, data)} vollständig zurück.`
        : `Es wurde nichts berechnet.`,
      `Rufen Sie uns gern unter ${data.businessPhone} an — wir finden zusammen einen neuen Termin.`,
    ],
    sms:
      `${data.businessName}: Wir müssen Ihren Termin am ${formatDate(data.startsAt, LOCALE)}, ` +
      `${formatTime(data.startsAt, LOCALE)} Uhr leider absagen. Grund: ${REASONS[data.reasonCode]}. ` +
      `Bitte rufen Sie uns an: ${data.businessPhone}`,
  }),

  BOOKING_RESCHEDULED: (data) => ({
    subject: `Neuer Termin: ${data.serviceName} am ${formatDate(data.startsAt, LOCALE)}`,
    blocks: [
      `Guten Tag ${data.customerFirstName},`,
      `Ihr Termin wurde verschoben.`,
      `Bisher: ${formatDateTime(data.previousStartsAt, LOCALE)} Uhr\nNeu: ${when(data)}\nbei ${data.employeeName}`,
      `Buchungsnummer ${data.reference}. Der bezahlte Betrag von ${price(data)} bleibt bestehen.`,
      `Termin verwalten: ${data.manageUrl}`,
    ],
    sms:
      `${data.businessName}: Ihr Termin wurde verschoben auf ${when(data)} bei ` +
      `${data.employeeName}. Nr. ${data.reference}. Verwalten: ${data.manageUrl}`,
  }),

  REMINDER_24H: (data) => ({
    // Das Datum statt „morgen“: dieselbe Vorlage bedient jeden konfigurierten Vorlauf.
    subject: `Erinnerung: Ihr Termin am ${formatDate(data.startsAt, LOCALE)} um ${formatTime(data.startsAt, LOCALE)} Uhr`,
    blocks: [
      `Guten Tag ${data.customerFirstName},`,
      `wir möchten Sie an Ihren Termin erinnern.`,
      `${data.serviceName}\n${when(data)}\nbei ${data.employeeName}`,
      `Sie finden uns in der ${data.addressLine}.`,
      `Falls Sie nicht kommen können, sagen Sie bitte rechtzeitig ab: ${data.manageUrl}`,
    ],
    sms:
      `${data.businessName}: Erinnerung an Ihren Termin ${when(data)}, ${data.serviceName} ` +
      `bei ${data.employeeName}. Absagen: ${data.manageUrl}`,
  }),

  CANCELLATION_REQUEST_RECEIVED: (data) => ({
    subject: `Stornierungsanfrage erhalten (${data.reference})`,
    blocks: [
      `Guten Tag ${data.customerFirstName},`,
      `wir haben Ihre Stornierungsanfrage für den Termin am ${when(data)} erhalten.`,
      `Da der Termin kurzfristig ist, prüfen wir die Anfrage persönlich. Voraussichtlich einbehalten: ${money(data.suggestedRetainedCents, data)} von ${price(data)}.`,
      `Sie hören innerhalb eines Werktags von uns. Bis dahin bleibt Ihr Termin bestehen.`,
    ],
  }),

  CANCELLATION_REQUEST_DECIDED: (data) => ({
    subject: data.approved
      ? `Stornierung bestätigt (${data.reference})`
      : `Stornierung nicht möglich (${data.reference})`,
    blocks: [
      `Guten Tag ${data.customerFirstName},`,
      data.approved
        ? `Ihre Stornierung für den ${when(data)} ist bestätigt.`
        : `wir können Ihre Stornierung für den ${when(data)} leider nicht annehmen. Ihr Termin bleibt bestehen.`,
      refundOutcome(data),
      data.note === null ? `Bei Fragen: ${data.businessPhone}` : `Anmerkung: ${data.note}`,
    ],
  }),

  RESCHEDULE_REQUEST_RECEIVED: (data) => ({
    subject: `Verschiebungsanfrage erhalten (${data.reference})`,
    blocks: [
      `Guten Tag ${data.customerFirstName},`,
      `wir haben Ihre Anfrage erhalten, den Termin vom ${when(data)} zu verschieben.`,
      `Gewünschter neuer Termin: ${formatDateTime(data.requestedStartsAt, LOCALE)} Uhr.`,
      `Wir prüfen das und melden uns. Bis dahin gilt Ihr bisheriger Termin.`,
    ],
  }),

  RESCHEDULE_REQUEST_DECIDED: (data) => ({
    subject: data.approved
      ? `Termin verschoben (${data.reference})`
      : `Verschiebung nicht möglich (${data.reference})`,
    blocks: [
      `Guten Tag ${data.customerFirstName},`,
      data.approved
        ? `Ihr Termin wurde verschoben. Neu: ${when(data)} bei ${data.employeeName}.`
        : `leider können wir Ihren Termin nicht verschieben. Es bleibt bei ${when(data)}.`,
      data.note === null ? `Bei Fragen: ${data.businessPhone}` : `Anmerkung: ${data.note}`,
      ...(data.manageUrl === null ? [] : [`Termin verwalten: ${data.manageUrl}`]),
    ],
  }),

  REFUND_ISSUED: (data) => ({
    subject: `Erstattung veranlasst (${data.reference})`,
    blocks: [
      `Guten Tag ${data.customerFirstName},`,
      `wir haben ${money(data.refundedCents, data)} für die Buchung ${data.reference} erstattet.`,
      `Die Rückbuchung erfolgt auf das ursprüngliche Zahlungsmittel und erscheint je nach Bank innerhalb von fünf bis zehn Werktagen.`,
      `Bei Fragen erreichen Sie uns unter ${data.businessPhone}.`,
    ],
  }),

  OFFICE_NEW_BOOKING: (data) => ({
    subject: `Neue Buchung: ${data.serviceName}, ${formatDate(data.startsAt, LOCALE)}`,
    blocks: [
      `Neue Online-Buchung.`,
      `${data.serviceName}\n${when(data)}\n${data.employeeName}\n${price(data)}\nNr. ${data.reference}`,
      `Kundin/Kunde: ${data.customerName}\n${data.customerEmail}${data.customerPhone === null ? '' : `\n${data.customerPhone}`}`,
      data.customerNote === null ? `Keine Anmerkung.` : `Anmerkung: ${data.customerNote}`,
    ],
  }),

  OFFICE_CANCELLATION_REQUEST: (data) => ({
    subject: `Stornierungsanfrage: ${data.reference} (${formatDate(data.startsAt, LOCALE)})`,
    blocks: [
      `Eine Stornierungsanfrage wartet auf Ihre Entscheidung.`,
      `${data.customerName}\n${data.serviceName}\n${when(data)}\n${data.employeeName}\nNr. ${data.reference}`,
      `Vorschlag nach Ihrer Stornoregel: ${money(data.suggestedRetainedCents, data)} einbehalten von ${price(data)}.`,
      data.reason === null ? `Kein Grund angegeben.` : `Begründung: ${data.reason}`,
    ],
  }),

  OFFICE_PASSWORD_RESET: (data) => ({
    subject: `Passwort zurücksetzen`,
    blocks: [
      `Guten Tag ${data.officeUserName},`,
      `über diesen Link setzen Sie Ihr Passwort neu: ${data.resetUrl}`,
      `Der Link gilt bis ${formatDateTime(data.expiresAt, LOCALE)} Uhr und kann einmal verwendet werden.`,
      `Falls Sie das nicht angefordert haben, ignorieren Sie diese Nachricht — Ihr Passwort bleibt unverändert.`,
    ],
  }),
};
