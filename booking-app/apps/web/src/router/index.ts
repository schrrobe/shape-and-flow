import { createRouter, createWebHistory } from 'vue-router';

import type { RouteRecordRaw } from 'vue-router';

/**
 * The routes that exist today.
 *
 * The booking wizard, the post-payment pages and the management pages add their own records as
 * they are built — a route pointing at a component that does not exist yet is a build that
 * passes and a link that 404s.
 */
const routes: RouteRecordRaw[] = [
  { path: '/', name: 'home', component: () => import('../pages/public/HomePage.vue') },

  {
    path: '/booking',
    component: () => import('../pages/public/BookingLayout.vue'),
    children: [
      { path: '', redirect: { name: 'booking-service' } },
      {
        path: 'service',
        name: 'booking-service',
        component: () => import('../pages/public/StepService.vue'),
      },
      {
        path: 'employee',
        name: 'booking-employee',
        component: () => import('../pages/public/StepEmployee.vue'),
      },
      {
        path: 'slot',
        name: 'booking-slot',
        component: () => import('../pages/public/StepSlot.vue'),
      },
      {
        path: 'details',
        name: 'booking-details',
        component: () => import('../pages/public/StepDetails.vue'),
      },
      {
        path: 'checkout',
        name: 'booking-checkout',
        component: () => import('../pages/public/RedirectToCheckout.vue'),
      },
    ],
  },
  {
    path: '/booking/success',
    name: 'booking-success',
    component: () => import('../pages/public/BookingSuccess.vue'),
  },
  {
    path: '/booking/canceled',
    name: 'booking-canceled',
    component: () => import('../pages/public/BookingCanceled.vue'),
  },

  {
    path: '/manage',
    name: 'manage',
    component: () => import('../pages/public/ManageBooking.vue'),
  },
  {
    path: '/manage/reschedule',
    name: 'manage-reschedule',
    component: () => import('../pages/public/ManageReschedule.vue'),
  },

  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('../pages/public/NotFoundPage.vue'),
  },
];

/**
 * The routes whose fragment is a credential rather than an anchor.
 *
 * The management link carries its token in the hash, deliberately — a fragment is not sent to
 * the server and stays out of access logs. That makes it the wrong thing to hand to a selector
 * lookup: no element matches, so the router logs a development warning *containing the token*,
 * and a token that is not a valid CSS id can make the lookup throw mid-navigation.
 *
 * Matched on the route name, not on the shape of the hash: a rule that guesses which fragments
 * look like secrets would be wrong the first time the token alphabet changes.
 */
const HASH_IS_A_CREDENTIAL: ReadonlySet<string> = new Set(['manage', 'manage-reschedule']);

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: (to, _from, savedPosition) => {
    // Restore on back, jump to the top otherwise: a wizard step that opens halfway down the
    // previous step's scroll position looks broken.
    if (savedPosition !== null) return savedPosition;

    const credential = typeof to.name === 'string' && HASH_IS_A_CREDENTIAL.has(to.name);
    if (to.hash !== '' && !credential) return { el: to.hash };

    return { top: 0 };
  },
});
