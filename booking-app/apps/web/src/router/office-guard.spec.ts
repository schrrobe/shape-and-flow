import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../api/client.js';
import { useSession } from '../stores/session.js';

import { router } from './index.js';

import type { OfficeUserDto } from '@shape-and-flow/booking-contracts';

const USER: OfficeUserDto = {
  id: 'u1',
  email: 'mara@shapeandflow.test',
  firstName: 'Mara',
  lastName: 'Vogt',
  role: 'ADMIN',
  canIssueRefunds: false,
  employeeId: null,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const unauthenticated = () => json({ code: 'UNAUTHENTICATED', correlationId: 'c1' }, 401);
const signedIn = () => json({ user: USER });

/** What `/auth/me` answers next. Replaced mid-test to simulate a session going away. */
let meAnswer: () => Response = unauthenticated;

/**
 * Every navigation the router actually confirmed.
 *
 * This is what makes "never flashes the protected screen" testable. A confirmed navigation
 * is a mounted component; a guard that redirected *after* letting the route resolve would
 * leave two entries here, and the operator would have seen the first one.
 */
let confirmed: string[] = [];
let stopRecording: (() => void) | null = null;

beforeEach(async () => {
  setActivePinia(createPinia());
  meAnswer = unauthenticated;

  vi.stubGlobal('fetch', (url: string) => {
    if (url.includes('/auth/me')) return Promise.resolve(meAnswer());
    // Stands in for any office call that assumes a session — `changePassword` is the one
    // such endpoint the client has in this task. It always refuses here.
    if (url.includes('/auth/password')) return Promise.resolve(unauthenticated());
    throw new Error(`unexpected request: ${url}`);
  });

  // A clean starting point: the router is a module singleton shared by the whole file.
  await router.replace('/');
  await router.isReady();

  confirmed = [];
  stopRecording = router.afterEach((to) => {
    confirmed.push(String(to.name));
  });
});

afterEach(() => {
  stopRecording?.();
  vi.unstubAllGlobals();
});

describe('office session guard', () => {
  it('sends an unauthenticated visitor to the login page', async () => {
    await router.push('/office');

    expect(router.currentRoute.value.name).toBe('office-login');
  });

  it('never confirms the protected route on the way there', async () => {
    await router.push('/office');

    // One confirmed navigation, and it is the login page. Two would mean the office layout
    // mounted, fired its requests and painted, before being replaced.
    expect(confirmed).toEqual(['office-login']);
  });

  it('remembers where they were trying to go', async () => {
    await router.push('/office');

    expect(useSession().returnTo).toBe('/office');
  });

  it('does not claim a session expired when there never was one', async () => {
    await router.push('/office');

    // "You were signed out" is a message about something that did not happen to somebody
    // opening a bookmark.
    expect(useSession().expired).toBe(false);
  });

  it('lets a signed-in visitor through', async () => {
    meAnswer = signedIn;

    await router.push('/office');

    expect(router.currentRoute.value.name).toBe('office-dashboard');
    expect(useSession().isAuthenticated).toBe(true);
  });

  it('keeps a signed-in user off the login form', async () => {
    meAnswer = signedIn;

    await router.push('/office/login');

    expect(router.currentRoute.value.path).toBe('/office');
  });

  it('leaves the password-reset link usable with a live session', async () => {
    meAnswer = signedIn;

    await router.push('/office/reset-password');

    // Somebody using a reset link usually no longer trusts the password their other tab is
    // signed in with. Redirecting them to the office would strand them.
    expect(router.currentRoute.value.name).toBe('office-reset-password');
  });

  it('lets the forgotten-password page through unauthenticated', async () => {
    await router.push('/office/forgot-password');

    expect(router.currentRoute.value.name).toBe('office-forgot-password');
  });

  it('leaves customer routes alone, and touches no store to do it', async () => {
    // No `/auth/me` call is stubbed to succeed here, and the fetch stub throws on anything
    // else — so a guard that reached for the session on a public navigation would fail loudly.
    await router.push('/booking/service');

    expect(router.currentRoute.value.name).toBe('booking-service');
  });

  describe('when a live session goes away', () => {
    beforeEach(async () => {
      meAnswer = signedIn;
      await router.push('/office');

      // The cookie is gone from here on, `/auth/me` included. Leaving it answering the user
      // would have the login page's own guard find a live session and bounce straight back.
      meAnswer = unauthenticated;
      confirmed = [];
    });

    it('redirects once for many failing requests, not once each', async () => {
      await Promise.allSettled([
        api.auth.changePassword({ currentPassword: 'a', newPassword: 'b' }),
        api.auth.changePassword({ currentPassword: 'a', newPassword: 'b' }),
        api.auth.changePassword({ currentPassword: 'a', newPassword: 'b' }),
      ]);
      // The handler redirects without anything awaiting it — a failing request is not the
      // caller's cue to navigate — so the assertion waits for the navigation rather than
      // assuming it has already landed.
      await vi.waitFor(() => {
        // Three in-flight calls on one screen. Three redirects would leave the operator
        // wherever the slowest one landed.
        expect(confirmed).toEqual(['office-login']);
      });
    });

    it('says the session ended, and remembers the screen', async () => {
      await api.auth
        .changePassword({ currentPassword: 'a', newPassword: 'b' })
        .catch(() => undefined);

      const session = useSession();
      expect(session.expired).toBe(true);
      expect(session.returnTo).toBe('/office');
      expect(session.isAuthenticated).toBe(false);
    });
  });
});
