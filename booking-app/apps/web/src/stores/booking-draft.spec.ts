import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';

import { DRAFT_STORAGE_KEY, useBookingDraft } from './booking-draft.js';

function storedDraft(): Record<string, unknown> {
  return JSON.parse(sessionStorage.getItem(DRAFT_STORAGE_KEY) ?? '{}') as Record<string, unknown>;
}

beforeEach(() => {
  sessionStorage.clear();
  setActivePinia(createPinia());
});

describe('the idempotency key', () => {
  it('is minted once per attempt and survives a reload', () => {
    const store = useBookingDraft();
    store.begin();

    const key = store.idempotencyKey;
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    // Re-entering the flow is not a new attempt: a new key would turn a resubmission into a
    // second booking.
    store.begin();
    expect(store.idempotencyKey).toBe(key);
    expect(storedDraft().idempotencyKey).toBe(key);
  });

  it('is re-read from storage after a reload', () => {
    const first = useBookingDraft();
    first.begin();
    const key = first.idempotencyKey;

    // A fresh store over the same storage is what a page reload produces.
    setActivePinia(createPinia());
    const second = useBookingDraft();

    expect(second.idempotencyKey).toBe(key);
  });

  it('is re-minted only after a reset', () => {
    const store = useBookingDraft();
    store.begin();
    const first = store.idempotencyKey;

    store.reset();
    store.begin();

    expect(store.idempotencyKey).not.toBe(first);
  });
});

describe('dependent choices', () => {
  it('clears the slot when the service changes', () => {
    const store = useBookingDraft();
    store.setService('s1');
    store.setEmployee('e1');
    store.setSlot(new Date('2026-08-14T07:00:00.000Z'));

    store.setService('s2');

    // A different service has different durations and staff, so the slot was never offered
    // for it.
    expect(store.slot).toBeNull();
    expect(store.employeeChosen).toBe(false);
  });

  it('keeps everything when the same service is chosen again', () => {
    const store = useBookingDraft();
    store.setService('s1');
    store.setEmployee('e1');
    store.setSlot(new Date('2026-08-14T07:00:00.000Z'));

    store.setService('s1');

    expect(store.slot).not.toBeNull();
  });

  it('clears the slot when the employee changes', () => {
    const store = useBookingDraft();
    store.setService('s1');
    store.setEmployee('e1');
    store.setSlot(new Date('2026-08-14T07:00:00.000Z'));

    store.setEmployee('e2');

    expect(store.slot).toBeNull();
  });

  it('treats "any employee" as a real choice', () => {
    const store = useBookingDraft();
    store.setService('s1');

    expect(store.canReach('slot')).toBe(false);

    store.setEmployee(null);

    // Null is a decision, not an absence: the customer said they do not mind.
    expect(store.employeeId).toBeNull();
    expect(store.employeeChosen).toBe(true);
    expect(store.canReach('slot')).toBe(true);
  });
});

describe('an explicit "any employee" choice', () => {
  it('survives a reload', () => {
    // Reconstructed from `employeeId !== null`, "anyone" comes back as unchosen — so a
    // customer who reloads on the slot step is bounced back to pick again, and the one
    // choice that cannot be told from its own absence is the common one.
    const first = useBookingDraft();
    first.setService('s1');
    first.setEmployee(null);

    setActivePinia(createPinia());
    const reloaded = useBookingDraft();

    expect(reloaded.employeeId).toBeNull();
    expect(reloaded.employeeChosen).toBe(true);
    expect(reloaded.canReach('slot')).toBe(true);
  });

  it('reads an older stored draft the way it was written', () => {
    // No `employeeChosen` in storage: a named employee was chosen, a null one was not.
    sessionStorage.setItem(
      DRAFT_STORAGE_KEY,
      JSON.stringify({ serviceId: 's1', employeeId: 'e1' }),
    );

    expect(useBookingDraft().employeeChosen).toBe(true);

    sessionStorage.setItem(
      DRAFT_STORAGE_KEY,
      JSON.stringify({ serviceId: 's1', employeeId: null }),
    );
    setActivePinia(createPinia());

    expect(useBookingDraft().employeeChosen).toBe(false);
  });
});

describe('a reservation that lapsed', () => {
  it('rotates the key and keeps every earlier choice', () => {
    // The old key is bound to the expired reservation. Re-submitting a new slot under it
    // is a different body for a spent key, which the API refuses as
    // IDEMPOTENCY_KEY_REUSED — so the customer is stuck at the very moment they were
    // told to pick again.
    const store = useBookingDraft();
    store.begin();
    store.setService('s1', { name: 'Massage', priceCents: 4500 });
    store.setEmployee('e1', 'Mara Vogt');
    store.setSlot(new Date('2026-08-14T07:00:00.000Z'));
    store.firstName = 'Anna';
    const oldKey = store.idempotencyKey;

    store.expireReservation();

    expect(store.idempotencyKey).not.toBe(oldKey);
    expect(store.idempotencyKey).not.toBeNull();
    expect(store.slot).toBeNull();
    expect(store.reservation).toBeNull();
    expect(store.firstName).toBe('Anna');
    expect(store.serviceId).toBe('s1');
    expect(storedDraft().idempotencyKey).toBe(store.idempotencyKey);
  });
});

describe('step reachability', () => {
  it('opens one step at a time', () => {
    const store = useBookingDraft();

    expect(store.canReach('service')).toBe(true);
    expect(store.canReach('employee')).toBe(false);

    store.setService('s1');
    expect(store.canReach('employee')).toBe(true);
    expect(store.canReach('slot')).toBe(false);

    store.setEmployee('e1');
    expect(store.canReach('slot')).toBe(true);
    expect(store.canReach('details')).toBe(false);

    store.setSlot(new Date('2026-08-14T07:00:00.000Z'));
    expect(store.canReach('details')).toBe(true);
  });

  it('still opens the slot step after a reload on the "anyone" path', async () => {
    const first = useBookingDraft();
    first.setService('s1');
    first.setEmployee(null);
    first.setSlot(new Date('2026-08-14T07:00:00.000Z'));

    // The watcher that writes to storage flushes before render, not synchronously. A real
    // reload is long after that; a test has to wait for it.
    await nextTick();

    // A fresh store over the same storage is what a page reload produces. "Anyone" is
    // `employeeId: null`, which looks exactly like "not asked yet" — so a derived
    // `employeeChosen` sent a customer with a slot already picked back to the employee step.
    setActivePinia(createPinia());
    const second = useBookingDraft();

    expect(second.employeeChosen).toBe(true);
    expect(second.canReach('slot')).toBe(true);
    expect(second.canReach('details')).toBe(true);
    expect(second.furthestReachable()).toBe('details');
  });

  it('treats a draft stored before employeeChosen existed as a choice, if it names an employee', () => {
    sessionStorage.setItem(
      DRAFT_STORAGE_KEY,
      JSON.stringify({ serviceId: 's1', employeeId: 'e1' }),
    );

    const store = useBookingDraft();

    expect(store.employeeChosen).toBe(true);
    expect(store.canReach('slot')).toBe(true);
  });

  it('reports the furthest reachable step, so a deep link lands somewhere useful', () => {
    const store = useBookingDraft();
    expect(store.furthestReachable()).toBe('service');

    store.setService('s1');
    expect(store.furthestReachable()).toBe('employee');

    store.setEmployee(null);
    expect(store.furthestReachable()).toBe('slot');
  });
});

describe('what is never persisted', () => {
  it('keeps the checkout url out of storage', () => {
    const store = useBookingDraft();
    store.begin();

    store.setReservation({
      bookingId: 'b1',
      reference: 'SF-1',
      status: 'PENDING_PAYMENT',
      employeeId: 'e1',
      employeeDisplayName: 'Mara',
      startsAt: '2026-08-14T07:00:00.000Z',
      endsAt: '2026-08-14T07:30:00.000Z',
      price: { amountCents: 4500, currency: 'EUR' },
      expiresAt: '2026-08-14T06:05:00.000Z',
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_1',
    });

    // A payment link in storage outlives the five-minute reservation and is readable by any
    // script on the origin.
    const raw = sessionStorage.getItem(DRAFT_STORAGE_KEY) ?? '';
    expect(raw).not.toContain('checkout');
    expect(raw).not.toContain('stripe');
    expect(store.reservation?.checkoutUrl).toContain('stripe');
  });

  it('survives storage that refuses to be written', () => {
    const original = sessionStorage.setItem.bind(sessionStorage);
    sessionStorage.setItem = () => {
      throw new Error('quota');
    };

    try {
      const store = useBookingDraft();
      // Private mode should degrade to an in-memory flow, not break booking entirely.
      expect(() => {
        store.begin();
      }).not.toThrow();
      expect(store.idempotencyKey).not.toBeNull();
    } finally {
      sessionStorage.setItem = original;
    }
  });

  it('ignores a stored draft written by an older shape', () => {
    sessionStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({ serviceId: 's1' }));

    const store = useBookingDraft();

    // Merged over a fresh draft, so a missing field is an empty string rather than undefined
    // rendered into an input.
    expect(store.serviceId).toBe('s1');
    expect(store.firstName).toBe('');
  });

  it('ignores unparseable storage', () => {
    sessionStorage.setItem(DRAFT_STORAGE_KEY, 'not json');

    expect(() => useBookingDraft()).not.toThrow();
  });
});

describe('clearing just the slot', () => {
  it('keeps the customer details, because they did nothing wrong', () => {
    const store = useBookingDraft();
    store.setService('s1');
    store.setEmployee('e1');
    store.setSlot(new Date('2026-08-14T07:00:00.000Z'));
    store.firstName = 'Anna';

    store.clearSlot();

    // What happens after SLOT_UNAVAILABLE: pick another time, do not retype your name.
    expect(store.slot).toBeNull();
    expect(store.firstName).toBe('Anna');
    expect(store.serviceId).toBe('s1');
  });
});
