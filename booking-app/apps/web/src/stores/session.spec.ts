import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSession } from './session.js';

import type { OfficeUserDto } from '@shape-and-flow/booking-contracts';

function officeUser(overrides: Partial<OfficeUserDto> = {}): OfficeUserDto {
  return {
    id: 'u1',
    email: 'mara@shapeandflow.test',
    firstName: 'Mara',
    lastName: 'Vogt',
    role: 'ADMIN',
    canIssueRefunds: false,
    employeeId: null,
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Every request the store made, in order, as `METHOD path`. */
let calls: string[] = [];

/** Queued answers, one per request; a missing entry is a test that under-specified. */
let answers: (() => Response | Promise<Response>)[] = [];

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  setActivePinia(createPinia());
  calls = [];
  answers = [];

  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${new URL(url, 'http://localhost').pathname}`);

    const next = answers.shift();
    if (next === undefined) throw new Error(`unexpected request: ${url}`);

    return Promise.resolve(next());
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('session store', () => {
  it('rehydrates from /auth/me on first load', async () => {
    answers = [() => json({ user: officeUser() })];

    const store = useSession();
    await store.hydrate();

    expect(store.user?.role).toBe('ADMIN');
    expect(store.isAuthenticated).toBe(true);
    expect(store.displayName).toBe('Mara Vogt');
    expect(calls).toEqual(['GET /api/auth/me']);
  });

  it('treats a 401 from /auth/me as simply not signed in', async () => {
    answers = [() => json({ code: 'UNAUTHENTICATED', correlationId: 'c1' }, 401)];

    const store = useSession();
    await store.hydrate();

    expect(store.isAuthenticated).toBe(false);
    // Not an expiry: nobody's session went away, they were never signed in. The login
    // screen says different things about the two.
    expect(store.expired).toBe(false);
    expect(store.unreachable).toBe(false);
  });

  it('distinguishes an unreachable server from a signed-out one', async () => {
    answers = [
      () => {
        throw new TypeError('Failed to fetch');
      },
    ];

    const store = useSession();
    await store.hydrate();

    expect(store.isAuthenticated).toBe(false);
    // Telling somebody whose wifi dropped that their session expired sends them to
    // re-enter a password that was never the problem.
    expect(store.unreachable).toBe(true);
  });

  it('asks /auth/me once when two navigations race a cold load', async () => {
    answers = [() => json({ user: officeUser() })];

    const store = useSession();
    await Promise.all([store.hydrate(), store.hydrate()]);

    expect(calls).toEqual(['GET /api/auth/me']);
  });

  it('re-asks on a later load, having cleared the in-flight promise', async () => {
    answers = [() => json({ user: officeUser() }), () => json({ user: officeUser() })];

    const store = useSession();
    await store.hydrate();
    await store.hydrate();

    // A cached promise that outlived its request would make a sign-out invisible.
    expect(calls).toHaveLength(2);
  });

  it('does not let an older hydrate undo markExpired', async () => {
    const pending = deferred<Response>();
    answers = [() => pending.promise];
    const store = useSession();

    const hydration = store.hydrate();
    store.markExpired('/office/bookings');
    pending.resolve(json({ user: officeUser() }));
    await hydration;

    expect(store.user).toBeNull();
    expect(store.expired).toBe(true);
  });

  it('does not let an older hydrate restore a user after logout', async () => {
    const pending = deferred<Response>();
    answers = [() => pending.promise, () => new Response(null, { status: 204 })];
    const store = useSession();

    const hydration = store.hydrate();
    await store.logout();
    pending.resolve(json({ user: officeUser() }));
    await hydration;

    expect(store.user).toBeNull();
    expect(store.isAuthenticated).toBe(false);
  });

  it('mirrors §10.5 for an admin', () => {
    const store = useSession();
    store.user = officeUser({ role: 'ADMIN', canIssueRefunds: false });

    expect(store.can('booking.cancel')).toBe(true);
    expect(store.can('refund.issue')).toBe(false);
    expect(store.can('settings.edit')).toBe(false);
  });

  it('mirrors §10.5 for an owner', () => {
    const store = useSession();
    store.user = officeUser({ role: 'OWNER', canIssueRefunds: false });

    expect(store.can('refund.issue')).toBe(true);
    expect(store.can('settings.edit')).toBe(true);
    expect(store.can('users.manage')).toBe(true);
  });

  it('reports an employee own-only grant as a scope, not a refusal', () => {
    const store = useSession();
    store.user = officeUser({ role: 'EMPLOYEE', employeeId: 'e1' });

    expect(store.can('booking.complete')).toBe(true);
    expect(store.scopeOf('booking.complete')).toBe('own');
    expect(store.scopeOf('calendar.viewAll')).toBe('none');
    expect(store.employeeId).toBe('e1');
  });

  it('grants nothing when nobody is signed in', () => {
    const store = useSession();

    expect(store.can('booking.view')).toBe(false);
    expect(store.scopeOf('booking.view')).toBe('none');
  });

  it('remembers the route an expired session was trying to reach', () => {
    const store = useSession();

    expect(store.markExpired('/office/calendar?date=2026-08-14')).toBe(true);
    expect(store.returnTo).toBe('/office/calendar?date=2026-08-14');
    expect(store.expired).toBe(true);
    expect(store.isAuthenticated).toBe(false);
  });

  it('handles one expiry, not one per in-flight request', () => {
    const store = useSession();

    expect(store.markExpired('/office/calendar?date=2026-08-14')).toBe(true);
    expect(store.markExpired('/office/bookings')).toBe(false);
    expect(store.markExpired('/office/settings')).toBe(false);

    // Four parallel requests on one screen would otherwise redirect four times, and the
    // last one would decide where the operator lands.
    expect(store.returnTo).toBe('/office/calendar?date=2026-08-14');
  });

  it('keeps the query string on the office root', () => {
    const store = useSession();

    store.markExpired('/office?filter=today');

    // Matching the whole string rather than the pathname rejected this, and dropped an
    // operator back to an unfiltered view of the screen they were reading.
    expect(store.returnTo).toBe('/office?filter=today');
  });

  it.each([
    'https://elsewhere.example/steal',
    '//elsewhere.example/steal',
    '/booking/service',
    '/officer/impostor',
  ])('refuses to remember %s', (path) => {
    const store = useSession();

    store.markExpired(path);

    // The value only ever comes from the router today, but "return to where you were" is
    // the field that grows a query parameter later.
    expect(store.returnTo).toBeNull();
  });

  it('hands back the remembered route on login and forgets it', async () => {
    const store = useSession();
    store.markExpired('/office/calendar?date=2026-08-14');

    answers = [() => json({ user: officeUser() })];
    const target = await store.login('mara@shapeandflow.test', 'correct horse battery');

    expect(target).toBe('/office/calendar?date=2026-08-14');
    expect(store.returnTo).toBeNull();
    expect(store.expired).toBe(false);
    expect(store.isAuthenticated).toBe(true);
    expect(calls).toEqual(['POST /api/auth/login']);
  });

  it('reports no target when the session never went anywhere', async () => {
    answers = [() => json({ user: officeUser() })];

    const store = useSession();

    expect(await store.login('mara@shapeandflow.test', 'correct horse battery')).toBeNull();
  });

  it('leaves a failed login signed out and throws for the form to show', async () => {
    answers = [() => json({ code: 'UNAUTHENTICATED', correlationId: 'c1' }, 401)];

    const store = useSession();

    await expect(store.login('mara@shapeandflow.test', 'wrong')).rejects.toThrow();
    expect(store.isAuthenticated).toBe(false);
    // A wrong password is not an expired session: no redirect handler must fire, or the
    // form navigates away from the message it was about to show.
    expect(store.expired).toBe(false);
  });

  it('clears everything on logout', async () => {
    answers = [() => json({ user: officeUser() }), () => new Response(null, { status: 204 })];

    const store = useSession();
    await store.hydrate();
    await store.logout();

    expect(store.user).toBeNull();
    expect(store.isAuthenticated).toBe(false);
    expect(calls).toEqual(['GET /api/auth/me', 'POST /api/auth/logout']);
  });

  it('signs out locally even when the call fails', async () => {
    answers = [
      () => json({ user: officeUser() }),
      () => {
        throw new TypeError('Failed to fetch');
      },
    ];

    const store = useSession();
    await store.hydrate();

    await expect(store.logout()).rejects.toThrow();
    // The server session may survive; a browser still showing the office interface after
    // somebody pressed "sign out" is the worse of the two failures.
    expect(store.user).toBeNull();
  });
});
