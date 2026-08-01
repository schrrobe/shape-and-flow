import { can as grants, capabilityScope } from '@shape-and-flow/booking-contracts';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { api, ApiError } from '../api/client.js';

import type { Capability, CapabilityScope, OfficeUserDto } from '@shape-and-flow/booking-contracts';

/**
 * Who is signed in to the office area.
 *
 * The session itself is an HTTP-only cookie the browser holds and this code cannot read.
 * What is kept here is the *description* of that session — who it belongs to and what
 * they may do — so a screen can hide a button the API would refuse. None of it is
 * authorization: every call is decided again on the server.
 */

/**
 * Where an expired session tried to go.
 *
 * Restricted to office paths on the way in rather than on the way out. It only ever
 * comes from the router's own `fullPath` today, but a "return to where you were" value
 * is exactly the field that later grows a query parameter, and an open redirect is
 * cheaper to prevent than to notice.
 */
function isOfficePath(path: string): boolean {
  // Compared on the pathname alone. Matching the whole string rejected `/office?filter=today`
  // — a real full-path from the router — and silently dropped the operator back to the office
  // root instead of the screen they were on.
  const pathname = path.split(/[?#]/)[0] ?? '';

  return pathname === '/office' || pathname.startsWith('/office/');
}

export const useSession = defineStore('session', () => {
  const user = ref<OfficeUserDto | null>(null);
  const returnTo = ref<string | null>(null);
  /** True once a live session was refused, as opposed to never having had one. */
  const expired = ref(false);
  /** True when `/auth/me` could not be reached at all — a different message from "signed out". */
  const unreachable = ref(false);

  /**
   * The one in-flight rehydration.
   *
   * Inside the store rather than at module scope, so each Pinia instance — and so each
   * test — gets its own. Two navigations racing on a cold load must await the same
   * request: two would mean two `/auth/me` calls, and the loser deciding last.
   */
  let inflight: Promise<void> | null = null;

  const isAuthenticated = computed(() => user.value !== null);
  const role = computed(() => user.value?.role ?? null);
  const canIssueRefunds = computed(() => user.value?.canIssueRefunds ?? false);
  const employeeId = computed(() => user.value?.employeeId ?? null);
  const displayName = computed(() =>
    user.value === null ? '' : `${user.value.firstName} ${user.value.lastName}`.trim(),
  );

  /**
   * Ask the server who this cookie belongs to.
   *
   * `/auth/me` reads the row rather than the session, so a renamed or demoted user is
   * current on the next load. A `401` here is the ordinary answer for somebody who is
   * simply not signed in, so it clears the user without marking an expiry — the two
   * cases read differently on the login screen.
   */
  async function hydrate(): Promise<void> {
    inflight ??= (async () => {
      try {
        const response = await api.auth.me();
        user.value = response.user;
        expired.value = false;
        unreachable.value = false;
      } catch (error) {
        user.value = null;
        // A 401 means "not signed in". Anything else means the answer never arrived, and
        // saying "your session expired" to somebody whose network dropped is a lie that
        // sends them to re-enter a password for no reason.
        unreachable.value = !(error instanceof ApiError && error.status === 401);
      } finally {
        inflight = null;
      }
    })();

    // Awaited rather than returned: it resolves to nothing, and `return await` on a
    // `Promise<void>` is a return statement that carries no value.
    await inflight;
  }

  /**
   * Sign in, and report where to go next.
   *
   * Returns the remembered path instead of navigating, so the store stays free of the
   * router. A component knows how to navigate; a store that did would be untestable
   * without one.
   */
  async function login(email: string, password: string): Promise<string | null> {
    const response = await api.auth.login({ email, password });

    user.value = response.user;
    expired.value = false;
    unreachable.value = false;

    const target = returnTo.value;
    returnTo.value = null;

    return target;
  }

  /**
   * Sign out.
   *
   * Cleared locally even when the call fails. The server-side session may survive a
   * network error, but leaving the browser showing a signed-in interface after somebody
   * pressed "sign out" is the worse of the two failures.
   */
  async function logout(): Promise<void> {
    try {
      await api.auth.logout();
    } finally {
      user.value = null;
      returnTo.value = null;
      expired.value = false;
      unreachable.value = false;
    }
  }

  /**
   * Remember where somebody was heading before they were sent to the login screen.
   *
   * Separate from `markExpired` because the two reasons for landing there are not the
   * same: a person who was never signed in has no session to have expired, and telling
   * them one did would be a message about something that never happened.
   */
  function rememberReturnTo(attemptedPath: string): void {
    returnTo.value = isOfficePath(attemptedPath) ? attemptedPath : null;
  }

  /**
   * Record that a live session is gone. Returns `true` only the first time.
   *
   * The return value is what stops a screen with four parallel requests from redirecting
   * four times: the first `401` wins, the rest are told it is already handled. It also
   * keeps the *first* attempted path, which is the one the operator was looking at.
   */
  function markExpired(attemptedPath: string): boolean {
    if (expired.value) return false;

    expired.value = true;
    user.value = null;
    rememberReturnTo(attemptedPath);

    return true;
  }

  /** May the signed-in user do this? `false` when nobody is signed in. */
  function can(capability: Capability): boolean {
    return user.value !== null && grants(user.value, capability);
  }

  /** How far their grant reaches — `'own'` is what an `EMPLOYEE` gets on several rows. */
  function scopeOf(capability: Capability): CapabilityScope {
    return user.value === null ? 'none' : capabilityScope(user.value, capability);
  }

  return {
    user,
    returnTo,
    expired,
    unreachable,
    isAuthenticated,
    role,
    canIssueRefunds,
    employeeId,
    displayName,
    hydrate,
    login,
    logout,
    rememberReturnTo,
    markExpired,
    can,
    scopeOf,
  };
});
