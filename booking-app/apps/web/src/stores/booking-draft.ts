import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';

import type { CreateBookingResponse, MoneyDto } from '@shape-and-flow/booking-contracts';

/**
 * `sessionStorage`, not `localStorage`.
 *
 * A half-finished booking should not outlive the browser session: coming back a week later to a
 * pre-filled slot that is long gone is worse than starting over. It survives a reload, which is
 * what matters — an accidental refresh mid-flow must not lose the idempotency key.
 */
export const DRAFT_STORAGE_KEY = 'sf.booking.draft';

export type Step = 'service' | 'employee' | 'slot' | 'details';

export const STEPS: Step[] = ['service', 'employee', 'slot', 'details'];

/** What is worth persisting. The Checkout URL is deliberately absent — see `checkoutUrl`. */
interface PersistedDraft {
  idempotencyKey: string | null;
  serviceId: string | null;
  /**
   * Display copies of what was chosen.
   *
   * Denormalised on purpose: the summary before payment has to name the service, the person and
   * the price, and re-fetching three endpoints to render a panel the customer just built is
   * wasteful. The *authoritative* price is the one the API returns with the reservation — these
   * are for showing back what was picked.
   */
  serviceName: string;
  servicePriceCents: number | null;
  employeeName: string | null;
  /** `null` means "any available employee", which is a real choice and not an empty one. */
  employeeId: string | null;
  /**
   * Persisted rather than derived from `employeeId`.
   *
   * "Anyone" is `employeeId: null`, which is indistinguishable from "not asked yet" — so
   * deriving it meant a reload turned the choice back into an absence, and `enforceReachable`
   * sent a customer with a slot already picked back to the employee step.
   */
  employeeChosen: boolean;
  slotStartsAt: string | null;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  note: string;
}

function emptyDraft(): PersistedDraft {
  return {
    idempotencyKey: null,
    serviceId: null,
    serviceName: '',
    servicePriceCents: null,
    employeeName: null,
    employeeId: null,
    employeeChosen: false,
    slotStartsAt: null,
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    note: '',
  };
}

function readStored(): PersistedDraft {
  try {
    const raw = sessionStorage.getItem(DRAFT_STORAGE_KEY);
    if (raw === null) return emptyDraft();

    // Merged over a fresh draft, so a stored shape from an older deploy cannot produce
    // undefined fields the form would then render as "undefined".
    return { ...emptyDraft(), ...(JSON.parse(raw) as Partial<PersistedDraft>) };
  } catch {
    return emptyDraft();
  }
}

/**
 * The booking being assembled.
 *
 * Two rules carry most of the weight:
 *
 *  - **One idempotency key per attempt.** Minted when the flow begins and kept across reloads,
 *    so a customer who refreshes the details step and submits again gets the *same* booking
 *    back rather than a second one. Re-minted only after a completed or reset attempt.
 *  - **Changing an earlier choice clears the later ones.** A slot belongs to a service and an
 *    employee; keeping it after either changes would submit a time that was never offered.
 */
export const useBookingDraft = defineStore('booking-draft', () => {
  const stored = readStored();

  const idempotencyKey = ref<string | null>(stored.idempotencyKey);
  const serviceId = ref<string | null>(stored.serviceId);
  const serviceName = ref(stored.serviceName);
  const servicePriceCents = ref<number | null>(stored.servicePriceCents);
  const employeeId = ref<string | null>(stored.employeeId);
  const employeeName = ref<string | null>(stored.employeeName);
  const slotStartsAt = ref<string | null>(stored.slotStartsAt);

  const firstName = ref(stored.firstName);
  const lastName = ref(stored.lastName);
  const email = ref(stored.email);
  const phone = ref(stored.phone);
  const note = ref(stored.note);

  /**
   * True once the customer has answered the employee step, "anyone" included.
   *
   * The `employeeId` fallback is for a draft written before this field existed: an id in
   * storage was a choice then and still is now.
   */
  const employeeChosen = ref(stored.employeeChosen || stored.employeeId !== null);

  /**
   * The hosted payment page, and the reservation it belongs to.
   *
   * In memory only. A Checkout URL in storage would outlive the five-minute reservation and
   * send a returning customer to a session that has already expired; worse, it is a link to a
   * payment page and storage is readable by any script on the origin.
   */
  const reservation = ref<CreateBookingResponse | null>(null);

  const slot = computed<Date | null>(() =>
    slotStartsAt.value === null ? null : new Date(slotStartsAt.value),
  );

  function persist(): void {
    const draft: PersistedDraft = {
      idempotencyKey: idempotencyKey.value,
      serviceId: serviceId.value,
      serviceName: serviceName.value,
      servicePriceCents: servicePriceCents.value,
      employeeId: employeeId.value,
      employeeName: employeeName.value,
      employeeChosen: employeeChosen.value,
      slotStartsAt: slotStartsAt.value,
      firstName: firstName.value,
      lastName: lastName.value,
      email: email.value,
      phone: phone.value,
      note: note.value,
    };

    try {
      sessionStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
    } catch {
      // Private mode, or a full quota. The flow still works in memory; only a reload loses it.
    }
  }

  watch(
    [
      idempotencyKey,
      serviceId,
      serviceName,
      servicePriceCents,
      employeeId,
      employeeName,
      employeeChosen,
      slotStartsAt,
      firstName,
      lastName,
      email,
      phone,
      note,
    ],
    persist,
  );

  /** Start an attempt, or resume the one already in progress. */
  function begin(): void {
    // Not re-minted on re-entry: navigating back into the flow is not a new attempt, and a new
    // key would turn a resubmission into a second booking.
    idempotencyKey.value ??= crypto.randomUUID();
    persist();
  }

  function setService(id: string, display?: { name: string; priceCents: number }): void {
    if (display !== undefined) {
      serviceName.value = display.name;
      servicePriceCents.value = display.priceCents;
    }

    if (serviceId.value === id) return;

    serviceId.value = id;
    // A different service has different durations, prices and staff. Everything downstream of
    // it is now a guess.
    employeeId.value = null;
    employeeName.value = null;
    employeeChosen.value = false;
    slotStartsAt.value = null;
  }

  /** `null` is "any available employee" — an explicit choice, so it counts as chosen. */
  function setEmployee(id: string | null, displayName?: string | null): void {
    employeeName.value = displayName ?? null;

    if (employeeChosen.value && employeeId.value === id) return;

    employeeId.value = id;
    employeeChosen.value = true;
    slotStartsAt.value = null;
  }

  function setSlot(startsAt: Date | null): void {
    slotStartsAt.value = startsAt === null ? null : startsAt.toISOString();
  }

  function setReservation(created: CreateBookingResponse | null): void {
    reservation.value = created;
  }

  /**
   * Whether a step can be entered.
   *
   * A deep link to the slot step without a service has nothing to load, so the layout redirects
   * rather than rendering an empty panel.
   */
  function canReach(step: Step): boolean {
    switch (step) {
      case 'service':
        return true;
      case 'employee':
        return serviceId.value !== null;
      case 'slot':
        return serviceId.value !== null && employeeChosen.value;
      case 'details':
        return serviceId.value !== null && employeeChosen.value && slotStartsAt.value !== null;
    }
  }

  /** The furthest step currently reachable, for a redirect that lands somewhere useful. */
  function furthestReachable(): Step {
    return [...STEPS].reverse().find((step) => canReach(step)) ?? 'service';
  }

  /**
   * Abandon the attempt and mint a new key next time.
   *
   * Used after a completed booking, and after `IDEMPOTENCY_KEY_REUSED` — which means the key
   * was already spent on a different payload, so the only way forward is a fresh attempt.
   */
  function reset(): void {
    idempotencyKey.value = null;
    serviceId.value = null;
    serviceName.value = '';
    servicePriceCents.value = null;
    employeeId.value = null;
    employeeName.value = null;
    employeeChosen.value = false;
    slotStartsAt.value = null;
    firstName.value = '';
    lastName.value = '';
    email.value = '';
    phone.value = '';
    note.value = '';
    reservation.value = null;

    try {
      sessionStorage.removeItem(DRAFT_STORAGE_KEY);
    } catch {
      // Nothing to do: the in-memory state is already cleared.
    }
  }

  /** Keep the customer's details and the service, but force a new slot. */
  function clearSlot(): void {
    slotStartsAt.value = null;
    reservation.value = null;
  }

  const price = computed<MoneyDto | null>(() => reservation.value?.price ?? null);

  return {
    idempotencyKey,
    serviceId,
    serviceName,
    servicePriceCents,
    employeeId,
    employeeName,
    employeeChosen,
    slotStartsAt,
    slot,
    firstName,
    lastName,
    email,
    phone,
    note,
    reservation,
    price,
    begin,
    setService,
    setEmployee,
    setSlot,
    setReservation,
    canReach,
    furthestReachable,
    clearSlot,
    reset,
  };
});
