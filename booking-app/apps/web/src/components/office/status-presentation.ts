import type { DisplayStatus } from '@shape-and-flow/booking-contracts';

/**
 * How each display status looks and reads.
 *
 * One exported map rather than a `v-if` ladder in the badge, for the reason the
 * capability matrix is a table: it is enumerable. `StatusBadge.spec.ts` iterates
 * `displayStatusSchema.options` against this, so a status added to the contract without
 * a presentation here fails a test instead of rendering an empty grey pill.
 *
 * `mark` is a short glyph carried beside the label, so the badge distinguishes states by
 * shape as well as by colour and by word — a calendar full of pills is scanned, not read.
 * The tone classes are the four the design tokens define; nothing here names a colour.
 */
export interface StatusPresentation {
  label: string;
  /** A token class, not a raw colour. The theme owns what "danger" looks like. */
  className: string;
  mark: string;
}

const NEUTRAL = 'bg-surface-muted text-text-secondary';
const LIVE = 'bg-success text-text-primary';
const WAITING = 'bg-warning text-text-primary';
const BAD = 'bg-danger text-text-primary';

export const STATUS_PRESENTATION: Readonly<Record<DisplayStatus, StatusPresentation>> = {
  // The slot is held but the money is not settled.
  PENDING_PAYMENT: { label: 'Awaiting payment', className: WAITING, mark: '\u25D4' },
  // The Stripe round trip. Reads the same to an operator as pending, because the
  // difference — which side is waiting — is not something they can act on.
  EXPIRING: { label: 'Awaiting payment', className: WAITING, mark: '\u25D4' },
  CONFIRMED: { label: 'Confirmed', className: LIVE, mark: '\u25CF' },
  COMPLETED: { label: 'Completed', className: NEUTRAL, mark: '\u2713' },
  NO_SHOW: { label: 'No show', className: BAD, mark: '\u2715' },
  CANCELED_BY_CUSTOMER: { label: 'Cancelled by customer', className: NEUTRAL, mark: '\u2298' },
  CANCELED_BY_BUSINESS: { label: 'Cancelled by us', className: NEUTRAL, mark: '\u2298' },
  EXPIRED: { label: 'Expired', className: NEUTRAL, mark: '\u2298' },
  PAYMENT_FAILED: { label: 'Payment failed', className: BAD, mark: '\u2715' },
  // The two derived statuses. Amber rather than red: somebody is waiting for an answer,
  // which is a thing to do rather than a thing that went wrong.
  CANCELLATION_REQUESTED: { label: 'Cancellation requested', className: WAITING, mark: '!' },
  RESCHEDULE_REQUESTED: { label: 'Move requested', className: WAITING, mark: '!' },
};
