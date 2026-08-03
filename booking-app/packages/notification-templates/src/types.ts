import type {
  Locale,
  NotificationChannel,
  NotificationKind,
} from '@shape-and-flow/booking-contracts';

export type { Locale, NotificationChannel, NotificationKind };

/** Fields every message carries, because every message is from a business to a person. */
export interface CommonData {
  businessName: string;
  businessPhone: string;
  addressLine: string;
  /** The reply-to a customer would actually use. */
  businessEmail: string;
}

/** Fields describing one appointment, shared by most kinds. */
export interface AppointmentData extends CommonData {
  reference: string;
  serviceName: string;
  employeeName: string;
  startsAt: Date;
  endsAt: Date;
  priceCents: number;
  currency: string;
  customerFirstName: string;
}

/**
 * Why the business cancelled, as a code rather than as prose.
 *
 * A code because the caller is server-side code with no locale of its own: passing a German
 * sentence into a template that may render in English put untranslated copy in front of a
 * customer. Each locale below resolves the code to its own wording, so a new reason is added
 * in one enum and two template files rather than wherever the sentence happened to live.
 *
 * The office's own free-text reason is deliberately not forwarded: it is written for internal
 * use and may say things — a staff illness, another customer — that should not be quoted to
 * the person on the other end.
 */
export type CancellationReasonCode = 'SEE_MESSAGE' | 'PAYMENT_FAILED';

/**
 * What each kind needs in order to render.
 *
 * A mapped type keyed by `NotificationKind`, which is what makes the registry below
 * exhaustive: adding a kind to the enum without adding an entry here is a type error, and
 * adding one here without a template in *both* locales is another.
 */
export interface TemplateData {
  BOOKING_CONFIRMATION: AppointmentData & {
    manageUrl: string;
    /** Null when no free window applies — a fixed-fee policy from the outset. */
    freeCancellationUntil: Date | null;
  };
  BOOKING_CANCELED_BY_CUSTOMER: AppointmentData & {
    refundedCents: number;
    retainedCents: number;
  };
  BOOKING_CANCELED_BY_BUSINESS: AppointmentData & {
    reasonCode: CancellationReasonCode;
    refundedCents: number;
  };
  BOOKING_RESCHEDULED: AppointmentData & {
    manageUrl: string;
    previousStartsAt: Date;
  };
  REMINDER_24H: AppointmentData & { manageUrl: string };
  CANCELLATION_REQUEST_RECEIVED: AppointmentData & { suggestedRetainedCents: number };
  CANCELLATION_REQUEST_DECIDED: AppointmentData & {
    approved: boolean;
    retainedCents: number;
    refundedCents: number;
    note: string | null;
  };
  RESCHEDULE_REQUEST_RECEIVED: AppointmentData & { requestedStartsAt: Date };
  RESCHEDULE_REQUEST_DECIDED: AppointmentData & {
    approved: boolean;
    manageUrl: string;
    note: string | null;
  };
  REFUND_ISSUED: AppointmentData & { refundedCents: number };
  OFFICE_NEW_BOOKING: AppointmentData & {
    customerName: string;
    customerEmail: string;
    customerPhone: string | null;
    customerNote: string | null;
  };
  OFFICE_CANCELLATION_REQUEST: AppointmentData & {
    customerName: string;
    suggestedRetainedCents: number;
    reason: string | null;
  };
  OFFICE_PASSWORD_RESET: CommonData & {
    officeUserName: string;
    resetUrl: string;
    expiresAt: Date;
  };
}

/** What a template produces. `html` is absent for SMS; `subject` is absent for SMS. */
export interface Rendered {
  subject?: string | undefined;
  text: string;
  html?: string | undefined;
}

/** The body a template returns, before the layout wraps it. */
export interface TemplateOutput {
  subject: string;
  /** Paragraphs. Joined with blank lines for text, wrapped in `<p>` for HTML. */
  blocks: string[];
  /** The one-line SMS form. Absent when the kind is email-only. */
  sms?: string;
}

export type TemplateFn<K extends NotificationKind> = (
  data: TemplateData[K],
  locale: Locale,
) => TemplateOutput;

/**
 * Every kind, in one locale.
 *
 * The mapped type is the guarantee: `Record<Locale, LocaleTemplates>` cannot be satisfied
 * with a German file that is missing a kind the English one has. A missing translation is
 * a compile error rather than an English email sent to a German customer.
 */
export type LocaleTemplates = { [K in NotificationKind]: TemplateFn<K> };
