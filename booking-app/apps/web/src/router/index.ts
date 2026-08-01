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
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('../pages/public/NotFoundPage.vue'),
  },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: (to, _from, savedPosition) => {
    // Restore on back, jump to the top otherwise: a wizard step that opens halfway down the
    // previous step's scroll position looks broken.
    if (savedPosition !== null) return savedPosition;
    if (to.hash !== '') return { el: to.hash };
    return { top: 0 };
  },
});
