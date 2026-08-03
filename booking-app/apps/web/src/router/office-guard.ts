import { setUnauthorizedHandler } from '../api/client.js';
import { useSession } from '../stores/session.js';

import type { NavigationGuardReturn, RouteLocationNormalized, Router } from 'vue-router';

/**
 * Nobody sees an office screen before the session is known.
 *
 * The guard **awaits** the rehydration rather than letting the route resolve and
 * correcting afterwards. The difference is visible: a resolved route mounts its
 * component, which fires its own requests and paints real chrome, and only then gets
 * replaced by the login page. Operators read that flash as the interface breaking.
 */
async function officeSessionGuard(to: RouteLocationNormalized): Promise<NavigationGuardReturn> {
  // Before the store, not after. This guard is global, so it also runs for every customer
  // navigation — and reaching for a Pinia store there would make the booking flow depend on
  // one existing, which is exactly what it did until a public-route test said so.
  if (to.meta.area !== 'office') return true;

  const session = useSession();

  /**
   * Someone already signed in has no business on the login form.
   *
   * Only the login route: a password-reset link must keep working for somebody who
   * happens to have a live session in another tab, because the reason they are using it
   * is usually that they no longer trust the password that session was opened with.
   */
  if (to.name === 'office-login') {
    if (!session.isAuthenticated) await session.hydrate();

    return session.isAuthenticated ? { path: '/office' } : true;
  }

  if (to.meta.requiresSession !== true) return true;

  if (!session.isAuthenticated) await session.hydrate();
  if (session.isAuthenticated) return true;

  // Recorded, not marked expired: this person may simply never have signed in.
  session.rememberReturnTo(to.fullPath);

  return { name: 'office-login' };
}

/**
 * Wire the guard and the mid-session `401` handler to a router.
 *
 * Called for its side effects at import time, which is safe because both are closures —
 * neither touches a store until a navigation or a request happens, by which point Pinia
 * is installed.
 */
export function installOfficeSessionHandling(router: Router): void {
  router.beforeEach(officeSessionGuard);

  setUnauthorizedHandler(() => {
    const session = useSession();

    // `markExpired` returns false when another in-flight request already reported this,
    // so a screen with four parallel calls redirects once — and to the route the operator
    // was actually looking at, not to whichever request happened to fail last.
    if (!session.markExpired(router.currentRoute.value.fullPath)) return;

    void router.replace({ name: 'office-login' });
  });
}
